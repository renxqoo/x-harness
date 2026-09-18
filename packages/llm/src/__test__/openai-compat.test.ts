// openai-compat 硬化矩阵（docs/LLM.md §1.4/§3）：共享假服务器表驱动 SSE 脚本——分片写撕裂、
// 失败契约（http-<status>/network/retryAfterMs）、abort、消息与工具表转换。

import { afterEach, describe, expect, it } from "vitest";
import { createOpenaiCompatAdapter } from "../openai-compat.ts";
import type { LlmChunk, LlmRequest } from "../types.ts";
import { startSceneServer } from "./scene-server.ts";
import type { SceneServer } from "./scene-server.ts";

let srv: SceneServer | undefined;

afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

function adapter(): ReturnType<typeof createOpenaiCompatAdapter> {
  return createOpenaiCompatAdapter({ baseUrl: srv?.baseUrl ?? "http://127.0.0.1:1", apiKey: "k-test" });
}

function request(over: Partial<LlmRequest> = {}): LlmRequest {
  return { model: "m", tools: [], messages: [], signal: new AbortController().signal, ...over };
}

async function collect(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const sse = (...frames: string[]): string[] => frames.map((frame) => `data: ${frame}\n\n`);
const DONE = "data: [DONE]\n\n";

describe("openai-compat 流解析硬化（docs/LLM.md §1.4/§3）", () => {
  it("纯文本流 + usage（finish 之后到达）+ finish(stop) + [DONE]", async () => {
    srv = await startSceneServer();
    srv.nextScene({
      status: 200,
      chunks: [
        ...sse('{"choices":[{"delta":{"content":"hel"}}]}'),
        ...sse('{"choices":[{"delta":{"content":"lo"}}]}'),
        ...sse('{"choices":[{"delta":{},"finish_reason":"stop"}]}'),
        ...sse('{"usage":{"prompt_tokens":3,"completion_tokens":2}}'),
        DONE,
      ],
    });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks).toEqual([
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo" },
      { type: "finish", finish: { kind: "stop" } },
      { type: "usage", usage: { input: 3, output: 2 } },
    ]);
  });

  it("工具调用分片：index 首现带 callId/name，arguments 增量；finish_reason=tool_calls → stop", async () => {
    srv = await startSceneServer();
    srv.nextScene({
      status: 200,
      chunks: [
        ...sse(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "add", arguments: '{"a"' } }] } }] })),
        ...sse('{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}'),
        ...sse('{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'),
        DONE,
      ],
    });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 0, callId: "c1", name: "add", argumentsDelta: '{"a"' },
      { type: "tool-call-delta", index: 0, argumentsDelta: ":1}" },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("finish_reason=length → max-tokens", async () => {
    srv = await startSceneServer();
    srv.nextScene({ status: 200, chunks: [...sse('{"choices":[{"delta":{"content":"cut"},"finish_reason":"length"}]}'), DONE] });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks.at(-1)).toEqual({ type: "finish", finish: { kind: "max-tokens" } });
  });

  it("跨 read 撕裂：半行 JSON 与多字节 UTF-8 跨片拼接", async () => {
    srv = await startSceneServer();
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "héllo→世界" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      DONE,
    ];
    const bytes = Buffer.from(frames.join(""));
    // 字节级切片：行边界与多字节 UTF-8 序列都被真正拆开（码点切片拆不开多字节字符）
    srv.nextScene({ status: 200, chunks: Array.from({ length: bytes.length }, (_, i) => bytes.subarray(i, i + 1)) });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks).toEqual([
      { type: "text-delta", text: "héllo→世界" },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("CRLF 行尾 / SSE 注释行 / event: 与 id: 行 / 空 data 跳过", async () => {
    srv = await startSceneServer();
    srv.nextScene({
      status: 200,
      chunks: [
        ": keep-alive comment\r\n\r\n",
        "event: message\r\nid: 42\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\r\n\r\n",
        "data:   \r\n\r\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\r\n\r\n",
        DONE,
      ],
    });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks).toEqual([
      { type: "text-delta", text: "x" },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("回归：EOF 半行合法帧（无尾换行）不丢——不误判截断触发重试", async () => {
    srv = await startSceneServer();
    srv.nextScene({
      status: 200,
      chunks: ['data: {"choices":[{"delta":{"content":"tail"}}]}\n\n', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'],
    });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks).toEqual([
      { type: "text-delta", text: "tail" },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("EOF 残量为垃圾文本：跳过不崩；无 finish → network 截断口径", async () => {
    srv = await startSceneServer();
    srv.nextScene({ status: 200, chunks: ["data: not-json"] });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks).toEqual([{ type: "finish", finish: { kind: "error", message: "stream ended without finish", code: "network" } }]);
  });

  it("回归：[DONE] = 终止符——停读，trailing 数据不混入消息且连接释放", async () => {
    srv = await startSceneServer();
    let connectionsClosed = 0;
    srv.onSocketClose(() => {
      connectionsClosed += 1;
    });
    srv.nextScene({
      status: 200,
      chunks: [...sse('{"choices":[{"delta":{"content":"a"}}]}'), ...sse('{"choices":[{"delta":{},"finish_reason":"stop"}]}'), DONE],
      afterDone: { delayMs: 60, frame: 'data: {"choices":[{"delta":{"content":"AFTER-DONE"}}]}\n\n' },
    });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks).toEqual([
      { type: "text-delta", text: "a" },
      { type: "finish", finish: { kind: "stop" } },
    ]);
    await new Promise((resolve) => {
      setTimeout(resolve, 120);
    });
    expect(connectionsClosed).toBe(1); // [DONE] 停读后 cancel 释放（不是等服务器 end）
  });

  it("回归：提前 break / [DONE] 后连接被客户端取消（无悬挂）", async () => {
    srv = await startSceneServer();
    let connectionsClosed = 0;
    srv.onSocketClose(() => {
      connectionsClosed += 1;
    });
    srv.nextScene({
      status: 200,
      chunks: [...sse('{"choices":[{"delta":{"content":"a"}}]}'), DONE],
      afterDone: { delayMs: 5_000, frame: "" },
    });
    const stream = adapter().stream(request());
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    await new Promise((resolve) => {
      setTimeout(resolve, 120);
    });
    expect(connectionsClosed).toBe(1);
  });

  it("截断流（无 [DONE] 无 finish_reason）→ network finish（可重试口径）", async () => {
    srv = await startSceneServer();
    srv.nextScene({ status: 200, chunks: [...sse('{"choices":[{"delta":{"content":"partial"}}]}')] });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks.at(-1)).toEqual({
      type: "finish",
      finish: { kind: "error", message: "stream ended without finish", code: "network" },
    });
  });
});

describe("openai-compat 失败契约（docs/LLM.md §1.2——abort throw；其余 finish{error, code}）", () => {
  it("非 2xx → http-<status> code + 体摘要（message 无状态前缀）", async () => {
    srv = await startSceneServer();
    srv.nextScene({ status: 500, chunks: ['{"error":"upstream blew"}'] });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks).toEqual([
      {
        type: "finish",
        finish: { kind: "error", message: '{"error":"upstream blew"}', code: "http-500" },
      },
    ]);
  });

  it.each([
    ["整数秒", "2", 2000],
    ["小数秒", "2.5", 2500],
    ["零（立即重试）", "0", 0],
  ])("429 Retry-After %s → retryAfterMs 原样（%s ms）", async (_name, header, expectedMs) => {
    srv = await startSceneServer();
    srv.nextScene({ status: 429, headers: { "retry-after": header }, chunks: ["rate limited"] });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks[0]).toEqual({
      type: "finish",
      finish: { kind: "error", message: "rate limited", code: "http-429", retryAfterMs: expectedMs },
    });
  });

  it("Retry-After HTTP-date：未来日期 → 相对毫秒；过去日期 → 0（立即）；垃圾 → 缺席", async () => {
    srv = await startSceneServer();
    const future = new Date(Date.now() + 3_000).toUTCString();
    const finishOf = async (header: string): Promise<{ code?: string; retryAfterMs?: number }> => {
      srv?.nextScene({ status: 503, headers: { "retry-after": header }, chunks: ["slow"] });
      const chunks = await collect(adapter().stream(request()));
      return (chunks[0] as { type: "finish"; finish: { code?: string; retryAfterMs?: number } }).finish;
    };
    const futureFinish = await finishOf(future);
    expect(futureFinish.code).toBe("http-503");
    expect(futureFinish.retryAfterMs).toBeGreaterThan(2_000);
    expect(futureFinish.retryAfterMs).toBeLessThanOrEqual(3_000);
    expect((await finishOf("Wed, 21 Oct 2015 07:28:00 GMT")).retryAfterMs).toBe(0);
    expect((await finishOf("not a date at all")).retryAfterMs).toBeUndefined();
  });

  it("连接拒绝 → network finish", async () => {
    const refused = createOpenaiCompatAdapter({ baseUrl: "http://127.0.0.1:1", apiKey: "k" });
    const chunks = await collect(refused.stream(request()));
    expect(chunks[0]).toMatchObject({ type: "finish", finish: { kind: "error", code: "network" } });
  });

  it("读体中断（分片已产出后断连）→ 分片保序 + network finish 收尾", async () => {
    srv = await startSceneServer();
    srv.nextScene({
      status: 200,
      chunks: [...sse('{"choices":[{"delta":{"content":"par"}}]}'), ...sse('{"choices":[{"delta":{"content":"tial"}}]}')],
      destroyAfterMs: 40,
    });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks).toEqual([
      { type: "text-delta", text: "par" },
      { type: "text-delta", text: "tial" },
      { type: "finish", finish: { kind: "error", message: expect.any(String), code: "network" } },
    ]);
  });

  it("请求前已 abort → throw AbortError", async () => {
    srv = await startSceneServer();
    const controller = new AbortController();
    controller.abort();
    await expect(collect(adapter().stream(request({ signal: controller.signal })))).rejects.toThrow();
  });
});

describe("openai-compat 请求体（docs/LLM.md §1.4 消息与工具表转换）", () => {
  it("四角色转换 + assistant 空 text 有 tool_calls → content null + 工具表含 description；无工具不落 tools 键", async () => {
    srv = await startSceneServer();
    srv.nextScene({ status: 200, chunks: [DONE] });
    await collect(
      adapter().stream(
        request({
          temperature: 0.7,
          maxTokens: 128,
          tools: [
            { name: "add", inputSchema: { type: "object" } },
            { name: "sub", description: "减法", inputSchema: { type: "object" } },
          ] as never,
          messages: [
            { role: "system", text: "sys" },
            { role: "user", content: [{ type: "text", text: "q1" }, { type: "text", text: "q2" }] },
            { role: "assistant", content: [{ type: "tool_use", callId: "c1", name: "add", input: "{}" }] },
            { role: "tool", callId: "c1", content: "3" },
          ] as never,
        }),
      ),
    );
    const captured = srv.captured();
    expect(captured?.method).toBe("POST");
    expect(captured?.path).toBe("/chat/completions");
    expect(captured?.headers["authorization"]).toBe("Bearer k-test");
    const body = captured?.body ?? {};
    expect(body["stream"]).toBe(true);
    expect(body["temperature"]).toBe(0.7);
    expect(body["max_tokens"]).toBe(128);
    expect(body["tools"]).toEqual([
      { type: "function", function: { name: "add", parameters: { type: "object" } } },
      { type: "function", function: { name: "sub", description: "减法", parameters: { type: "object" } } },
    ]);
    expect(body["messages"]).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "q1\nq2" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "add", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "3" },
    ]);

    srv.nextScene({ status: 200, chunks: [DONE] });
    await collect(adapter().stream(request()));
    expect(Object.hasOwn(srv.captured()?.body ?? {}, "tools")).toBe(false);
  });
});
