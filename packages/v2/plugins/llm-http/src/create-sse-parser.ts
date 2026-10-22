import type { LlmResult, LlmLimits } from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
import type { SseFrame } from "./types";

export function createSseParser(
  limits: Pick<LlmLimits, "maxEventBytes" | "maxOutputBytes" | "maxEvents">,
) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line: string[] = [];
  let lineBytes = 0;
  let frameBytes = 0;
  let total = 0;
  let frames = 0;
  let event = "message";
  let data: string[] = [];
  let skipLf = false;
  let failed = false;

  const failure = (capacity = false) => {
    failed = true;
    return llmFailure(capacity ? "capacity-exceeded" : "protocol-error", { phase: "stream" });
  };

  return {
    *push(chunk: Uint8Array): Generator<LlmResult<SseFrame>> {
      if (failed) {
        yield failure();
        return;
      }

      total += chunk.byteLength;

      if (total > limits.maxOutputBytes * 4 + limits.maxEventBytes) {
        yield failure(true);
        return;
      }

      let source: string;

      try {
        source = decoder.decode(chunk, { stream: true });
      } catch {
        yield failure();
        return;
      }

      let start = 0;

      for (let index = 0; index < source.length; index++) {
        const char = source[index];

        if (skipLf) {
          skipLf = false;

          if (char === "\n") {
            start = index + 1;
            continue;
          }
        }

        if (char !== "\r" && char !== "\n") continue;

        const part = source.slice(start, index);
        line.push(part);
        lineBytes += new TextEncoder().encode(part).length;
        frameBytes += lineBytes + 2;

        if (frameBytes > limits.maxEventBytes) {
          yield failure(true);
          return;
        }

        const content = line.join("");
        line = [];
        lineBytes = 0;
        start = index + 1;
        skipLf = char === "\r";

        if (!content) {
          if (data.length) {
            if (++frames > limits.maxEvents) {
              yield failure(true);
              return;
            }

            const frame = Object.freeze({ event, data: data.join("\n") });
            data = [];
            event = "message";
            frameBytes = 0;
            yield { ok: true, value: frame };
          } else {
            event = "message";
            frameBytes = 0;
          }
        } else if (!content.startsWith(":")) {
          const split = content.indexOf(":");
          const field = split < 0 ? content : content.slice(0, split);
          let value = split < 0 ? "" : content.slice(split + 1);

          if (value.startsWith(" ")) value = value.slice(1);

          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
      }

      if (start < source.length) {
        const tail = source.slice(start);
        line.push(tail);
        lineBytes += new TextEncoder().encode(tail).length;

        if (frameBytes + lineBytes > limits.maxEventBytes) yield failure(true);
      }
    },
    finish(): LlmResult<void> {
      if (failed) return failure();

      try {
        decoder.decode();
        return { ok: true, value: undefined };
      } catch {
        return failure();
      }
    },
  };
}
