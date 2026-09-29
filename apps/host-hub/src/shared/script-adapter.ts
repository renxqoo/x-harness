import type { LlmAdapter, LlmChunk, LlmRequest, TokenUsage } from "@x-harness/llm";

export type ScriptStep =
  | { readonly reply: string; readonly thinking?: string }
  | { readonly toolCalls: readonly { readonly name: string; readonly input: string }[] }
  | { readonly error: { readonly code: string; readonly message?: string; readonly retryable?: boolean } }
  | { readonly delayMs: number };

export interface ScriptAdapter extends LlmAdapter {
  readonly consumed: number;
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
