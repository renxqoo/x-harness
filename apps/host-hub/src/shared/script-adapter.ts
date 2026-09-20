// 剧本适配器（DESIGN §5 测试缝）：env HUB_WORKER_PROVIDER=script + HUB_WORKER_SCRIPT
// （JSON 剧本内联）注入——e2e/内嵌测试的确定性 LLM 替身。剧本步顺序消费，每次
// stream() 调用消费至首个终结步（reply/toolCalls/error）；delayMs 步在调用内睡眠
// （可叠加多个）；耗尽 → error-finish（empty-response）。abort 语义对齐内核契约：
// 适配器抛 AbortError（非 error-finish 流）。
import type { LlmAdapter, LlmChunk, LlmRequest, TokenUsage } from "@x-harness/llm";

export type ScriptStep =
  | { readonly reply: string; readonly thinking?: string }
  | { readonly toolCalls: readonly { readonly name: string; readonly input: string }[] }
  | { readonly error: { readonly code: string; readonly message?: string; readonly retryable?: boolean } }
  | { readonly delayMs: number };

export interface ScriptAdapter extends LlmAdapter {
  /** 已消费的终结步数（断言面） */
  readonly consumed: number;
  /** 最近一次请求的 thinking 档（断言面） */
  lastThinking: string | undefined;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function usageOf(input: number, output: number): TokenUsage {
  return { input, output, totalTokens: input + output };
}

export function createScriptAdapter(script: readonly ScriptStep[] = []): ScriptAdapter {
  let cursor = 0;
  let consumed = 0;
  const adapter: ScriptAdapter = {
    name: "script",
    contextWindow: 200_000,
    get consumed(): number {
      return consumed;
    },
    lastThinking: undefined,
    async *stream(request: LlmRequest): AsyncIterable<LlmChunk> {
      adapter.lastThinking = request.thinking;
      for (;;) {
        const step = script[cursor];
        if (step === undefined) {
          yield { type: "finish", finish: { kind: "error", message: "empty-response", code: "empty-response" } };
          return;
        }
        cursor += 1;
        if ("delayMs" in step) {
          await abortableSleep(step.delayMs, request.signal);
          continue;
        }
        consumed += 1;
        if ("error" in step) {
          yield { type: "finish", finish: { kind: "error", message: step.error.message ?? step.error.code, code: step.error.code } };
          return;
        }
        if ("toolCalls" in step) {
          for (const [index, call] of step.toolCalls.entries()) {
            yield { type: "tool-call-delta", index, callId: `call-${cursor}-${index}`, name: call.name, argumentsDelta: call.input };
          }
          yield { type: "usage", usage: usageOf(64, 16) };
          yield { type: "finish", finish: { kind: "stop" } };
          return;
        }
        if (step.thinking !== undefined && step.thinking !== "") {
          yield { type: "thinking-delta", text: step.thinking };
        }
        yield { type: "text-delta", text: step.reply };
        yield { type: "usage", usage: usageOf(64, 16 + step.reply.length) };
        yield { type: "finish", finish: { kind: "stop" } };
        return;
      }
    },
  };
  return adapter;
}

/** 从 env 解析剧本（HUB_WORKER_SCRIPT = JSON 内联；缺席 = 空剧本——每步 empty-response） */
export function scriptFromEnv(env: Readonly<Record<string, string | undefined>>): ScriptStep[] {
  const raw = env["HUB_WORKER_SCRIPT"];
  if (raw === undefined || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ScriptStep[]) : [];
  } catch {
    return [];
  }
}
