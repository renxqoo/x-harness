// pi 真身冒烟（docs/LLM-PI.md 测试口径·真身层）：scene-server 假 HTTP/SSE × pi api-level stream 真身——
// 注入面测不到的 wire 行为在这里防守：非 2xx→http-<status>、retry-after 头捕获、中途断连→network、
// 请求头硬化（identity/单份 anthropic-version）、wire 体形状（无 cache_control、system 顶层、
// openai 仅显式 maxTokens）、usage 字段级合并。

import { afterEach, describe, expect, it } from "vitest";
import { createAnthropicCompatAdapter, createOpenaiCompatAdapter } from "../pi-adapter.ts";
import type { LlmChunk, LlmRequest } from "../types.ts";
import { startSceneServer } from "./scene-server.ts";
import type { SceneServer } from "./scene-server.ts";

let srv: SceneServer | undefined;

afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

function request(over: Partial<LlmRequest> = {}): LlmRequest {
  return { model: "m", tools: [], messages: [], signal: new AbortController().signal, ...over };
}

async function collect(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const sse = (type: string, fields: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;

function anthropicFullFlow(): string[] {
  return [
    sse("message_start", { message: { usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } }),
    sse("content_block_start", { index: 0, content_block: { type: "text", text: "he" } }),
    sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "llo" } }),
    sse("content_block_stop", { index: 0 }),
    sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }),
    sse("message_stop", {}),
  ];
}

describe("pi 真身冒烟：anthropic-messages", () => {
  it("全文流：初值+delta+usage 折算+finish stop；请求头/体硬化断言", async () => {
    srv = await startSceneServer();
    srv.nextScene({ status: 200, chunks: anthropicFullFlow() });
    const adapter = createAnthropicCompatAdapter({ baseUrl: srv.baseUrl, apiKey: "k-test" });
    const chunks = await collect(
      adapter.stream(
        request({
          messages: [
            { role: "system", text: "sys" },
            { role: "user", content: [{ type: "text", text: "q" }] },
          ] as never,
        }),
      ),
    );
    expect(chunks).toEqual([
      { type: "text-delta", text: "he" }, // P10 初值
      { type: "text-delta", text: "llo" },
      { type: "usage", usage: { input: 17, output: 7 } }, // 10+5+2 折入
      { type: "finish", finish: { kind: "stop" } },
    ]);
    const captured = srv.captured();
    expect(captured?.path?.startsWith("/v1/messages")).toBe(true); // pi 对 custom model 追加 ?beta=true
    expect(captured?.body["model"]).toBe("m"); // 请求体 model = request.model（适配器名不进请求体）
    expect(captured?.headers["x-api-key"]).toBe("k-test");
    expect(captured?.headers["accept-encoding"]).toBe("identity"); // SSE 不协商压缩
    expect(String(captured?.headers["anthropic-version"])).toBeTruthy();
    expect(captured?.body["stream"]).toBe(true);
    expect(captured?.body["max_tokens"]).toBe(8192);
    expect(captured?.body["system"]).toEqual([{ type: "text", text: "sys" }]); // pi wire 形态：system 块数组
    expect(JSON.stringify(captured?.body)).not.toContain("cache_control"); // cacheRetention none
  });

  it("非 2xx：429 + retry-after 头 → http-429 + retryAfterMs（onResponse 捕获）", async () => {
    srv = await startSceneServer();
    srv.nextScene({ status: 429, headers: { "retry-after": "2.5" }, chunks: ["data: {}"] });
    const adapter = createAnthropicCompatAdapter({ baseUrl: srv.baseUrl, apiKey: "k-test" });
    const chunks = await collect(adapter.stream(request({})));
    expect(chunks).toEqual([
      { type: "finish", finish: { kind: "error", message: expect.stringContaining("429"), code: "http-429", retryAfterMs: 2500 } },
    ]);
  });

  it("流中途断连 → error 事件 → network；连接拒绝 → network", async () => {
    srv = await startSceneServer();
    srv.nextScene({
      status: 200,
      chunks: anthropicFullFlow().slice(0, 3),
      destroyAfterMs: 150, // 分片已产出、流中途断
    });
    const adapter = createAnthropicCompatAdapter({ baseUrl: srv.baseUrl, apiKey: "k-test" });
    const chunks = await collect(adapter.stream(request({})));
    expect(chunks.some((c) => c.type === "text-delta")).toBe(true);
    expect(chunks.at(-1)).toMatchObject({ type: "finish", finish: { kind: "error", code: "network" } });

    const refused = createAnthropicCompatAdapter({ baseUrl: "http://127.0.0.1:1", apiKey: "k" });
    const refusedChunks = await collect(refused.stream(request({})));
    expect(refusedChunks.at(-1)).toMatchObject({ type: "finish", finish: { kind: "error", code: "network" } });
  });

  it("请求前已 abort → throw（豁免路径不变）", async () => {
    srv = await startSceneServer();
    const adapter = createAnthropicCompatAdapter({ baseUrl: srv.baseUrl, apiKey: "k-test" });
    const controller = new AbortController();
    controller.abort();
    await expect(collect(adapter.stream(request({ signal: controller.signal })))).rejects.toThrow();
  });

  it("工具流全链路：tool_use 分片 → toolcall_end 单帧完整出口；finish tool_use→stop", async () => {
    srv = await startSceneServer();
    srv.nextScene({
      status: 200,
      chunks: [
        sse("message_start", { message: { usage: { input_tokens: 5 } } }),
        sse("content_block_start", { index: 0, content_block: { type: "tool_use", id: "t1", name: "add" } }),
        sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"a"' } }),
        sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: ":1}" } }),
        sse("content_block_stop", { index: 0 }),
        sse("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }),
        sse("message_stop", {}),
      ],
    });
    const adapter = createAnthropicCompatAdapter({ baseUrl: srv.baseUrl, apiKey: "k-test" });
    const chunks = await collect(adapter.stream(request({})));
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 0, callId: "t1", name: "add", argumentsDelta: '{"a":1}' }, // 单帧全量出口
      { type: "usage", usage: { input: 5, output: 9 } },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("redacted_thinking → 广播 \"[Reasoning redacted]\" 思考帧（语义变更，docs/LLM-PI.md）", async () => {
    srv = await startSceneServer();
    srv.nextScene({
      status: 200,
      chunks: [
        sse("message_start", { message: { usage: { input_tokens: 1 } } }),
        sse("content_block_start", { index: 0, content_block: { type: "redacted_thinking" } }),
        sse("content_block_stop", { index: 0 }),
        sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
        sse("message_stop", {}),
      ],
    });
    const adapter = createAnthropicCompatAdapter({ baseUrl: srv.baseUrl, apiKey: "k-test" });
    const chunks = await collect(adapter.stream(request({})));
    expect(chunks).toEqual([
      { type: "thinking-delta", text: "[Reasoning redacted]" },
      { type: "usage", usage: { input: 1, output: 2 } },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("500 体摘要进 error message；anthropic-version 单份不重复", async () => {
    srv = await startSceneServer();
    srv.nextScene({ status: 500, chunks: ['{"error":"upstream blew"}'] });
    const adapter = createAnthropicCompatAdapter({ baseUrl: srv.baseUrl, apiKey: "k-test" });
    const chunks = await collect(adapter.stream(request({})));
    expect(chunks.at(-1)).toMatchObject({
      type: "finish",
      finish: { kind: "error", code: "http-500", message: expect.stringContaining("upstream blew") },
    });
    const version = String(srv.captured()?.headers["anthropic-version"]);
    expect(version).not.toContain(","); // 单份（node 对重复头 join 成数组含逗号）
  });

  it.each([
    ["秒小数", { "retry-after": "2" }, 2000],
    ["HTTP-date 未来", { "retry-after": new Date(Date.now() + 5000).toUTCString() }, "4000-5000"],
    ["HTTP-date 过去=0", { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }, 0],
    ["毫秒语义头", { "retry-after-ms": "1800" }, 1800],
  ])("Retry-After 头捕获链路：%s", async (_name, headers, expected) => {
    srv = await startSceneServer();
    srv.nextScene({ status: 429, headers: headers as Record<string, string>, chunks: ["data: {}"] });
    const adapter = createAnthropicCompatAdapter({ baseUrl: srv.baseUrl, apiKey: "k-test" });
    const chunks = await collect(adapter.stream(request({})));
    const finish = chunks.at(-1);
    if (finish?.type !== "finish" || finish.finish.kind !== "error") throw new Error("非 error finish");
    expect(finish.finish.code).toBe("http-429");
    if (expected === "4000-5000") {
      expect(finish.finish.retryAfterMs).toBeGreaterThanOrEqual(4000);
      expect(finish.finish.retryAfterMs).toBeLessThanOrEqual(5000);
    } else {
      expect(finish.finish.retryAfterMs).toBe(expected);
    }
  });
});

describe("pi 真身冒烟：openai-completions", () => {
  it("全文流：usage 后置折算 + finish stop；仅显式 maxTokens；Bearer + identity 头", async () => {
    srv = await startSceneServer();
    srv.nextScene({
      status: 200,
      chunks: [
        'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n',
        "data: [DONE]\n\n",
      ],
    });
    const adapter = createOpenaiCompatAdapter({ baseUrl: srv.baseUrl, apiKey: "k-open" });
    const chunks = await collect(adapter.stream(request({})));
    expect(chunks).toEqual([
      { type: "text-delta", text: "he" },
      { type: "text-delta", text: "llo" },
      { type: "usage", usage: { input: 3, output: 4 } },
      { type: "finish", finish: { kind: "stop" } },
    ]);
    const captured = srv.captured();
    expect(captured?.path).toBe("/chat/completions");
    expect(captured?.body["model"]).toBe("m");
    expect(String(captured?.headers["authorization"])).toContain("Bearer");
    expect(captured?.headers["accept-encoding"]).toBe("identity");
    expect(Object.hasOwn(captured?.body ?? {}, "max_tokens")).toBe(false); // 仅显式才发
    expect(captured?.body["stream"]).toBe(true);
  });
});
