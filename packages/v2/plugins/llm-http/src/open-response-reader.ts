import type { LlmResult } from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";

export function openResponseReader(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  let done = false;
  let cancellation: Promise<LlmResult<void>> | undefined;

  const cancel = () => {
    cancellation ??= reader.cancel().then(
      (): LlmResult<void> => ({ ok: true, value: undefined }),
      (): LlmResult<void> => llmFailure("network-error", { phase: "close" }),
    );
  };

  signal.addEventListener("abort", cancel, { once: true });

  if (signal.aborted) cancel();

  return {
    async read() {
      const value = await reader.read();
      done ||= value.done;
      return value;
    },
    async close(): Promise<LlmResult<void>> {
      signal.removeEventListener("abort", cancel);

      if (!done) cancel();

      const result = cancellation ? await cancellation : ({ ok: true, value: undefined } as const);

      try {
        reader.releaseLock();
      } catch {
        return llmFailure("network-error", { phase: "close" });
      }

      return result;
    },
  };
}
