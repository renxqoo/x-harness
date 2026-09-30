import type { LlmAdapter, LlmChunk, LlmRequest } from "@x-harness/llm";

export type ScriptStep =
  | { readonly reply: string; readonly thinking?: string }
  | { readonly toolCalls: readonly { readonly name: string; readonly input: string }[] }
  | { readonly error: { readonly code: string; readonly message?: string; readonly retryable?: boolean } }
  | { readonly delayMs: number };

export interface ScriptAdapter extends LlmAdapter {
  readonly consumed: number;
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
    async *stream(_request: LlmRequest): AsyncIterable<LlmChunk> {
      for (;;) {
        const step = script[cursor];
        if (step === undefined) {
          yield { type: "finish", finish: { kind: "stop" } };
          return;
        }
        cursor += 1;
        consumed += 1;
        if ("delayMs" in step) {
          await sleep(step.delayMs);
          continue;
        }
        if ("error" in step) {
          return;
        }
        if ("toolCalls" in step) {
          yield { type: "finish", finish: { kind: "stop" } };
          continue;
        }
        if (step.thinking !== undefined) {
          yield { type: "thinking-delta", text: step.thinking };
        }
        yield { type: "text-delta", text: step.reply };
        yield { type: "finish", finish: { kind: "stop" } };
        return;
      }
    },
  };
  return adapter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
