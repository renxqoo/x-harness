import type { LlmResult, ProviderEnd } from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
import type { HttpRequest } from "./types";
import { createSseParser } from "./create-sse-parser";
import { openResponseReader } from "./open-response-reader";
import { readHttpFailure } from "./read-http-failure";
export async function requestStream(input: HttpRequest): Promise<LlmResult<ProviderEnd>> {
  const opened = await input.control.step("headers", input.limits.headersTimeoutMs, async () => ({ ok: true, value: await input.config.fetch(`${input.config.baseUrl}${input.path}`, { method: "POST", redirect: "error", signal: input.control.signal, headers: { ...input.config.headers, ...input.headers, "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(input.body) }) }));
  if (!opened.ok) return opened; const response = opened.value; if (!response.ok) return readHttpFailure(response, input);
  if (!response.body || response.headers.get("content-type")?.toLowerCase().split(";")[0]?.trim() !== "text/event-stream") { try { await response.body?.cancel(); } catch { return llmFailure("network-error", { phase: "close" }); } return llmFailure("protocol-error", { phase: "headers" }); }
  const reader = openResponseReader(response.body, input.control.signal); const parser = createSseParser(input.limits); let stopped = false;
  const consume = async (): Promise<LlmResult<ProviderEnd>> => {
  try {
    const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id"); if (requestId && requestId.length <= 256) { const sent = await input.onEvent({ type: "response-info", info: { protocol: input.protocol, requestId } }); if (!sent.ok) return sent; }
    for (;;) {
      const read = await input.control.step("stream", input.limits.idleTimeoutMs, async () => ({ ok: true, value: await reader.read() })); if (!read.ok) return read; if (read.value.done) { break; } const bytes = read.value.value;
      for (let offset = 0; offset < bytes.length; offset += 65536) for (const frame of parser.push(bytes.subarray(offset, offset + 65536))) {
        if (!frame.ok) return frame; const decoded = input.decoder.accept(frame.value); if (!decoded.ok) return decoded; for (const event of decoded.value.events) { const sent = await input.onEvent(event); if (!sent.ok) return sent; } stopped ||= decoded.value.stop;
      }
      if (stopped) break;
    }
    const tail = parser.finish(); if (!tail.ok) return tail; if (input.control.error()) return { ok: false, error: input.control.error()! }; return input.decoder.finish();
  } catch { return input.control.error() ? { ok: false, error: input.control.error()! } : llmFailure("network-error", { phase: "stream" }); }
  };
  const outcome = await consume(); const closed = await reader.close(); return outcome.ok && !closed.ok ? closed : outcome;
}
