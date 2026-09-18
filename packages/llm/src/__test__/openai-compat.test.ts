// openai-compat 适配器（docs/LLM.md §1.3/§3）：本地真实 HTTP 假服务器喂 SSE 脚本。

import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenaiCompatAdapter } from "../openai-compat.ts";
import type { LlmChunk, LlmRequest } from "../types.ts";

let server: Server;
let baseUrl: string;
let lastBody: Record<string, unknown> | undefined;
let script: readonly string[] = [];
let status = 200;

beforeEach(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      lastBody = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(status, { "content-type": "text/event-stream" });
      for (const frame of script) res.write(frame);
      res.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  script = [];
  status = 200;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

const request = (overrides: Partial<LlmRequest> = {}): LlmRequest => ({
  model: "test-model",
  tools: [],
  messages: [],
  signal: new AbortController().signal,
  ...overrides,
});

async function collect(chunks: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

function sse(payload: string): string {
  return `data: ${payload}\n\n`;
}

describe("openai-compat SSE 解析（docs/LLM.md §3）", () => {
  it("纯文本流 + usage + finish(stop) + [DONE]", async () => {
    script = [
      sse(JSON.stringify({ choices: [{ delta: { content: "He" } }] })),
      sse(JSON.stringify({ choices: [{ delta: { content: "llo" } }] })),
      sse(JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 2 } })),
      sse(JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })),
      "data: [DONE]\n\n",
    ];
    const chunks = await collect(createOpenaiCompatAdapter({ baseUrl, apiKey: "k" }).stream(request()));
    expect(chunks).toEqual([
      { type: "text-delta", text: "He" },
      { type: "text-delta", text: "llo" },
      { type: "usage", usage: { input: 3, output: 2 } },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("工具调用分片：index 首现带 callId/name，arguments 增量", async () => {
    script = [
      sse(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{\"p" } }] } }] })),
      sse(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "ath\":1}" } }] } }] })),
      sse(JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })),
      "data: [DONE]\n\n",
    ];
    const chunks = await collect(createOpenaiCompatAdapter({ baseUrl, apiKey: "k" }).stream(request()));
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 0, callId: "call_1", name: "read", argumentsDelta: '{"p' },
      { type: "tool-call-delta", index: 0, argumentsDelta: 'ath":1}' },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("finish_reason=length → max-tokens；跨读块边界拼接", async () => {
    const payload = sse(JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }));
    script = [payload.slice(0, 5), payload.slice(5), "data: [DONE]\n\n"]; // 人为撕裂读块
    const chunks = await collect(createOpenaiCompatAdapter({ baseUrl, apiKey: "k" }).stream(request()));
    expect(chunks).toEqual([{ type: "finish", finish: { kind: "max-tokens" } }]);
  });

  it("非 2xx → throw 带状态码与响应体摘要", async () => {
    status = 429;
    script = [];
    await expect(
      collect(createOpenaiCompatAdapter({ baseUrl, apiKey: "k" }).stream(request())),
    ).rejects.toThrow("llm-http-429");
  });

  it("请求体格式：messages 四角色转换 + tools 表 + 采样参数", async () => {
    script = ["data: [DONE]\n\n"];
    await collect(
      createOpenaiCompatAdapter({ baseUrl, apiKey: "k" }).stream(
        request({
          temperature: 0.2,
          maxTokens: 128,
          tools: [{ name: "t", description: "d", inputSchema: { type: "object" } as never }],
          messages: [
            { role: "system", text: "sys" },
            { role: "user", content: [{ type: "text", text: "hi" }] },
            { role: "assistant", content: [{ type: "tool_use", callId: "c1", name: "t", input: "{}" }] },
            { role: "tool", callId: "c1", content: "ok" },
          ],
        }),
      ),
    );
    expect(lastBody?.["messages"]).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ]);
    expect(lastBody?.["tools"]).toEqual([
      { type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } },
    ]);
    expect(lastBody?.["temperature"]).toBe(0.2);
    expect(lastBody?.["max_tokens"]).toBe(128);
    expect(lastBody?.["stream"]).toBe(true);
  });

  it("请求前已 abort → throw", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(createOpenaiCompatAdapter({ baseUrl, apiKey: "k" }).stream(request({ signal: controller.signal }))),
    ).rejects.toThrow();
  });
});
