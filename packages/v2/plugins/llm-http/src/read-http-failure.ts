import type { LlmResult } from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
import type { HttpRequest } from "./types";
import { openResponseReader } from "./open-response-reader";
import { readRetryAfter } from "./read-retry-after";
export async function readHttpFailure(response: Response, input: HttpRequest): Promise<LlmResult<never>> {
  let providerCode: string | undefined; const reader = response.body ? openResponseReader(response.body, input.control.signal) : undefined; let done = false;
  if (reader) {
    try { const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) { const read = await input.control.step("stream", input.limits.idleTimeoutMs, async () => ({ ok: true, value: await reader.read() })); if (!read.ok) return read; if (read.value.done) { done = true; break; } bytes += read.value.value.byteLength; if (bytes > 16384) break; chunks.push(read.value.value); }
      if (done) { const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0)); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { error?: { code?: unknown; type?: unknown } }; const code = parsed?.error?.code ?? parsed?.error?.type; if (typeof code === "string" && ["context_length_exceeded", "model_context_window_exceeded", "invalid_api_key", "authentication_error", "permission_error", "rate_limit_error", "invalid_request_error", "overloaded_error", "request_too_large"].includes(code)) providerCode = code; }
    } catch { }
    finally { await reader.close(); }
  }
  let code: import("../../llm/src/contracts").LlmErrorCode = "provider-error";
  if (response.status === 401) code = "authentication-failed"; else if (response.status === 403) code = "permission-denied"; else if (response.status === 429) code = "rate-limited"; else if (response.status === 413) code = "request-too-large"; else if (providerCode && ["context_length_exceeded", "model_context_window_exceeded"].includes(providerCode)) code = "context-overflow";
  const retryAfterMs = readRetryAfter(response.headers, input.config.now()); const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");
  return llmFailure(code, { phase: "headers", status: response.status, ...(providerCode ? { providerCode } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), ...(requestId && requestId.length <= 256 ? { requestId } : {}) });
}
