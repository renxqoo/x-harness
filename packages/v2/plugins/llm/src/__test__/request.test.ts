import { expect, it } from "vitest";
import { readLlmRequest } from "../domain/read-request";
import { readLlmLimits } from "../domain/read-limits";
import type { LlmResult } from "../contracts";
function value<T>(result: LlmResult<T>): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; }
const limits = value(readLlmLimits());
const request = () => ({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hello😀" }] }] });
it("request snapshots data without executing getters or retaining caller mutations", () => {
  const input = request(); const read = value(readLlmRequest(input, limits)); input.messages[0]!.content[0]!.text = "changed"; expect(read.messages[0]!.content[0]).toEqual({ type: "text", text: "hello😀" }); expect(Object.isFrozen(read.messages)).toBe(true);
  let calls = 0; expect(readLlmRequest(Object.defineProperty({}, "model", { get() { calls++; return "m"; } }), limits)).toMatchObject({ ok: false }); expect(calls).toBe(0);
});
it.each([null, [], {}, { ...request(), model: "" }, { ...request(), model: 1 }, { ...request(), unknown: true }, { ...request(), messages: [null] }, { ...request(), messages: [{ role: "tool", callId: "orphan", content: [] }] }, { ...request(), maxOutputTokens: 0 }, { ...request(), timeoutMs: -1 }, { ...request(), signal: {} }, { ...request(), tools: [{ name: "t", inputSchema: [] }] }, { ...request(), temperature: Infinity }, { ...request(), topP: 2 }, { ...request(), output: { type: "unknown" } }, { ...request(), providerTools: [{ type: "file-search", vectorStoreIds: [] }] }])("garbage requests return a typed failure: %j", (input) => { expect(readLlmRequest(input, limits)).toMatchObject({ ok: false, error: { source: "llm", code: "invalid-input" } }); });
it("tool histories require complete pairing and never silently discard dangling calls", () => {
  const messages = [{ role: "assistant", content: [{ type: "tool-call", callId: "c", name: "add", input: { x: 1 } }] }, { role: "tool", callId: "c", content: [{ type: "text", text: "1" }] }];
  expect(readLlmRequest({ model: "m", messages }, limits).ok).toBe(true); expect(readLlmRequest({ model: "m", messages: messages.slice(0, 1) }, limits)).toMatchObject({ ok: false }); expect(readLlmRequest({ model: "m", messages: [...messages, messages[1]] }, limits)).toMatchObject({ ok: false });
});
it("UTF8 byte, count, schema and provider-option limits are enforced before transport", () => {
  expect(readLlmRequest(request(), { ...limits, maxInputBytes: 20 })).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } }); expect(readLlmRequest(request(), { ...limits, maxMessages: 0 })).toMatchObject({ ok: false });
  expect(readLlmRequest({ ...request(), providerOptions: { model: "override" } }, limits)).toMatchObject({ ok: false }); expect(readLlmRequest({ ...request(), tools: [{ name: "t", inputSchema: { type: "object" } }, { name: "t", inputSchema: {} }] }, limits)).toMatchObject({ ok: false });
});
