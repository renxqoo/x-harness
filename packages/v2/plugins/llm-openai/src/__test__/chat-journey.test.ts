import { afterEach, expect, it } from "vitest";
import { createHost } from "../../../../core/src/index";
import type { Host } from "../../../../core/src/index";
import { createLlmPlugin, defineLlmProvider, llm, streamLlm } from "../../../llm/src/index";
import type { LlmEvent, LlmResult, LlmService } from "../../../llm/src/contracts";
import { createOpenaiPlugin } from "../index";
import { createLlmServer, sse } from "../../../../fixtures/llm-server";
function value<T>(result: LlmResult<T>): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; }
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(): Promise<{ server: ReturnType<typeof createLlmServer>; host: Host; service: LlmService }> {
  const server = createLlmServer(); cleanup.push(() => server.close()); const host = value(createHost({ limits: { callTimeoutMs: 3000 } })); cleanup.push(() => host.close()); const token = value(defineLlmProvider("chat-test"));
  value(await host.install([value(createOpenaiPlugin({ api: "chat-completions", token, baseUrl: server.baseUrl, apiKey: "key-test", models: { m: { output: ["text", "json", "json-schema"] } } })), value(createLlmPlugin({ providers: { primary: token }, defaultProvider: "primary" }))]));
  return { server, host, service: value(host.use(llm)) };
}
function textScene(text = "hello😀") { return [sse({ id: "r", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }), sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), sse({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }), sse("[DONE]")]; }
it("real HTTP chat preserves text, usage tail, response identity and closes managed work", async () => {
  const f = await fixture(); f.server.scene({ chunks: textScene() }); const events: LlmEvent[] = []; const receipt = await f.service.stream({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], onEvent(event) { events.push(event); } }); expect(receipt.ok).toBe(true); const result = value(receipt);
  expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7, complete: true }); expect(result.response).toMatchObject({ requestId: "req-fixture", responseId: "r", protocol: "openai-chat-completions" }); expect(events.flatMap((e) => e.type === "text-delta" ? [e.delta] : []).join("")).toBe("hello😀"); expect(events.at(-1)?.type).toBe("finish"); expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i)); expect(f.server.requests[0]!.headers.get("authorization")).toBe("Bearer key-test"); expect(f.host.inspect().activeCalls).toBe(0); expect(f.host.inspect().activeTasks).toBe(0);
});
it("parallel tools retain actual argument fragments and generate one parsed call per block", async () => {
  const f = await fixture(); f.server.scene({ chunks: [sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "add", arguments: '{"x":' } }, { index: 0, id: "c1", function: { name: "add", arguments: '{"x":2}' } }] } }] }), sse({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] }), sse("[DONE]")] });
  const result = value(await f.service.generate({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "tools" }] }], tools: [{ name: "add", inputSchema: { type: "object", properties: { x: { type: "integer" } }, required: ["x"], additionalProperties: false } }] }));
  expect(result.reason).toEqual({ kind: "tool-calls" }); expect(result.content.map((b) => b.call)).toEqual([{ callId: "c2", name: "add", input: { ok: true, value: { x: 1 } } }, { callId: "c1", name: "add", input: { ok: true, value: { x: 2 } } }]);
});
it("stream and generate reject the same schema violation before any success terminal", async () => {
  const f = await fixture(); const request = { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "json" }] }] as const, output: { type: "json-schema", name: "result", schema: { type: "object", properties: { x: { type: "integer" } }, required: ["x"], additionalProperties: false } } as const }; const events: LlmEvent[] = [];
  for (const mode of ["stream", "generate"] as const) { f.server.scene({ chunks: textScene('{"x":"bad"}') }); const result = mode === "stream" ? await f.service.stream({ ...request, onEvent(event) { events.push(event); } }) : await f.service.generate(request); expect(result).toMatchObject({ ok: false, error: { code: "invalid-output" } }); }
  expect(events.some((e) => e.type === "finish")).toBe(false); expect(events.at(-1)?.type).toBe("error");
});
it("iteration is lazy, single-slot and retains the original service receipt", async () => {
  const f = await fixture(); f.server.scene({ chunks: textScene("iterated") }); const stream = streamLlm(f.service, { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }); expect(f.server.requests).toHaveLength(0); const events: LlmEvent[] = []; for await (const event of stream) events.push(event); expect(value(await stream.result).reason).toEqual({ kind: "stop" }); expect(events.at(-1)?.type).toBe("finish");
});
it("Chat refusal with stop stays refusal instead of becoming invalid JSON output", async () => { const f = await fixture(); for (const mode of ["stream", "generate"] as const) { f.server.scene({ chunks: [sse({ choices: [{ delta: { refusal: "Cannot assist" } }] }), sse({ choices: [{ delta: {}, finish_reason: "stop" }] }), sse("[DONE]")] }); const input = { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] as const, output: { type: "json" } as const }; const result = value(mode === "stream" ? await f.service.stream({ ...input, onEvent() {} }) : await f.service.generate(input)); expect(result.reason).toEqual({ kind: "refusal" }); expect(result.rawReason).toBe("stop"); } });
