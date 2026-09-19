// anthropic-compat 全矩阵（docs/LLM.md §1.5/§3）：请求体精确 JSON 断言（system 顶层化/块序合并/
// 孤立合成/input 降级/max_tokens 缺省）+ 流事件矩阵（usage 快照与字段级合并/stop_reason 全集/
// 稀疏 index/终止符停读与连接释放/finish 后 error 忽略/截断口径）。

import { afterEach, describe, expect, it } from "vitest";
import { createAnthropicCompatAdapter } from "../anthropic-compat.ts";
import type { LlmChunk, LlmRequest } from "../types.ts";
import { startSceneServer } from "./scene-server.ts";
import type { SceneServer } from "./scene-server.ts";

let srv: SceneServer | undefined;

afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

function adapter(over: { maxTokensDefault?: number } = {}): ReturnType<typeof createAnthropicCompatAdapter> {
  return createAnthropicCompatAdapter({ baseUrl: srv?.baseUrl ?? "http://127.0.0.1:1", apiKey: "k-test", ...over });
}

function request(over: Partial<LlmRequest> = {}): LlmRequest {
  return { model: "m", tools: [], messages: [], signal: new AbortController().signal, ...over };
}

async function collect(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

/** 事件帧构造（event: 行 + data: JSON）——JSON.stringify 免转义 */
const ev = (type: string, fields: Record<string, unknown> = {}): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;

describe("anthropic-compat 请求体（docs/LLM.md §1.5）", () => {
  it("system 顶层化；相邻合并块序：tool_result 前置、user 文本独立块在后（steer 可见）", async () => {
    srv = await startSceneServer();
    srv.nextScene({ status: 200, chunks: [ev("message_stop")] });
    await collect(
      adapter().stream(
        request({
          temperature: 0.3,
          messages: [
            { role: "system", text: "sys-a" },
            { role: "system", text: "sys-b" },
            { role: "user", content: [{ type: "text", text: "do it" }] },
            { role: "assistant", content: [{ type: "tool_use", callId: "c1", name: "add", input: "{}" }] },
            { role: "tool", callId: "c1", content: "3" },
            { role: "user", content: [{ type: "text", text: "steer" }] },
          ] as never,
        }),
      ),
    );
    const captured = srv.captured();
    expect(captured?.path).toBe("/v1/messages");
    expect(captured?.headers["x-api-key"]).toBe("k-test");
    expect(captured?.headers["anthropic-version"]).toBe("2023-06-01");
    // SSE 恒不协商压缩：运行时默认 accept-encoding 会换来无逐块 flush 的 gzip/br 攒批（http-dial 实验复现）
    expect(captured?.headers["accept-encoding"]).toBe("identity");
    const body = captured?.body ?? {};
    expect(body["system"]).toBe("sys-a\n\nsys-b");
    expect(body["temperature"]).toBe(0.3);
    expect(body["max_tokens"]).toBe(8192); // 协议必填缺省
    expect(body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "do it" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "add", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "3" }, { type: "text", text: "steer" }] },
    ]);
  });

  it("孤立 tool_use（中断历史）合成 is_error 空结果——重放不再 400", async () => {
    srv = await startSceneServer();
    srv.nextScene({ status: 200, chunks: [ev("message_stop")] });
    await collect(
      adapter().stream(
        request({
          messages: [
            { role: "user", content: [{ type: "text", text: "go" }] },
            { role: "assistant", content: [{ type: "tool_use", callId: "z1", name: "t", input: "{bad" }, { type: "tool_use", callId: "z2", name: "t", input: "null" }] },
            { role: "user", content: [{ type: "text", text: "next" }] },
          ] as never,
        }),
      ),
    );
    const body = srv.captured()?.body ?? {};
    expect(body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "go" }] },
      // input 解析失败与非对象（"null"）降 {}；两个孤立 callId 合成空结果（插入序）
      { role: "assistant", content: [{ type: "tool_use", id: "z1", name: "t", input: {} }, { type: "tool_use", id: "z2", name: "t", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "z1", content: "(no result provided)", is_error: true },
          { type: "tool_result", tool_use_id: "z2", content: "(no result provided)", is_error: true },
          { type: "text", text: "next" },
        ],
      },
    ]);
  });

  it("并行多 tool_result 合并一条 user；isError → is_error；空 user 跳过；maxTokensDefault 逃生位", async () => {
    srv = await startSceneServer();
    srv.nextScene({ status: 200, chunks: [ev("message_stop")] });
    await collect(
      adapter({ maxTokensDefault: 1024 }).stream(
        request({
          messages: [
            { role: "assistant", content: [{ type: "tool_use", callId: "a", name: "t", input: "{}" }, { type: "tool_use", callId: "b", name: "t", input: "{}" }] },
            { role: "tool", callId: "a", content: "1" },
            { role: "tool", callId: "b", content: "boom", isError: true },
            { role: "user", content: [] },
          ] as never,
        }),
      ),
    );
    const body = srv.captured()?.body ?? {};
    expect(body["max_tokens"]).toBe(1024);
    expect(body["messages"]).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "t", input: {} }, { type: "tool_use", id: "b", name: "t", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "1" },
          { type: "tool_result", tool_use_id: "b", content: "boom", is_error: true },
        ],
      },
    ]);
  });

  it("input 降级全向量：parse 失败/数组/原始值 → {}；尾部孤立独立收尾组；assistant text 块原样", async () => {
    srv = await startSceneServer();
    srv.nextScene({ status: 200, chunks: [ev("message_stop")] });
    await collect(
      adapter().stream(
        request({
          messages: [
            { role: "user", content: [{ type: "text", text: "go" }] },
            { role: "assistant", content: [{ type: "text", text: "thinking aloud" }, { type: "tool_use", callId: "q1", name: "t", input: "[1]" }, { type: "tool_use", callId: "q2", name: "t", input: "5" }] },
          ] as never,
        }),
      ),
    );
    expect(srv.captured()?.body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking aloud" },
          { type: "tool_use", id: "q1", name: "t", input: {} },
          { type: "tool_use", id: "q2", name: "t", input: {} },
        ],
      },
      // 尾部孤立（无后续 user 组）：独立收尾组合成两个空结果
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "q1", content: "(no result provided)", is_error: true },
          { type: "tool_result", tool_use_id: "q2", content: "(no result provided)", is_error: true },
        ],
      },
    ]);
  });

  it("回归：同 callId 重复出现按次数配对——第二次孤立仍合成（answered 集合曾误判已答）", async () => {
    srv = await startSceneServer();
    srv.nextScene({ status: 200, chunks: [ev("message_stop")] });
    await collect(
      adapter().stream(
        request({
          messages: [
            { role: "assistant", content: [{ type: "tool_use", callId: "c1", name: "t", input: "{}" }] },
            { role: "tool", callId: "c1", content: "1" },
            { role: "assistant", content: [{ type: "tool_use", callId: "c1", name: "t", input: "{}" }] },
            { role: "user", content: [{ type: "text", text: "next" }] },
          ] as never,
        }),
      ),
    );
    const messages = srv.captured()?.body["messages"] as Array<{ role: string; content: Array<{ type: string; tool_use_id?: string }> }>;
    const lastUser = messages.at(-1);
    expect(lastUser?.role).toBe("user");
    expect(lastUser?.content.some((b) => b.type === "tool_result" && b.tool_use_id === "c1")).toBe(true); // 第二次出现仍合成
  });

  it("工具表 → input_schema 形状；无工具不落 tools 键", async () => {
    srv = await startSceneServer();
    srv.nextScene({ status: 200, chunks: [ev("message_stop")] });
    await collect(
      adapter().stream(
        request({
          maxTokens: 64,
          tools: [{ name: "add", inputSchema: { type: "object" } }, { name: "sub", description: "减", inputSchema: { type: "object" } }] as never,
        }),
      ),
    );
    const body = srv.captured()?.body ?? {};
    expect(body["max_tokens"]).toBe(64);
    expect(body["tools"]).toEqual([
      { name: "add", input_schema: { type: "object" } },
      { name: "sub", description: "减", input_schema: { type: "object" } },
    ]);
    srv?.nextScene({ status: 200, chunks: [ev("message_stop")] });
    await collect(adapter().stream(request()));
    expect(Object.hasOwn(srv.captured()?.body ?? {}, "tools")).toBe(false);
  });
});

describe("anthropic-compat 流事件（docs/LLM.md §1.5）", () => {
  it("全文流：usage 值来源断言（input 来自 message_start 含 cache 桶折入；output 来自 message_delta）+ thinking→text 全序 + finish(stop)", async () => {
    srv = await startSceneServer();
    srv.nextScene({
      status: 200,
      chunks: [
        ev("message_start", { message: { usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } }),
        ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "pl" } }),
        ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "an" } }),
        ev("content_block_stop", { index: 0 }),
        ev("content_block_start", { index: 1, content_block: { type: "text", text: "he" } }),
        ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "llo" } }),
        ev("content_block_stop", { index: 1 }),
        ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }),
        ev("message_stop"),
      ],
    });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks).toEqual([
      { type: "usage", usage: { input: 17 } }, // 10+5+2 折入
      { type: "thinking-delta", text: "pl" }, // content_block_start 初值不丢（P10）
      { type: "thinking-delta", text: "an" },
      { type: "text-delta", text: "he" },
      { type: "text-delta", text: "llo" },
      { type: "usage", usage: { input: 17, output: 7 } }, // 字段级合并快照
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("工具调用：tool_use 身份（index 原值透传）+ input_json_delta 分片 + thinking 块夹杂", async () => {
    srv = await startSceneServer();
    srv.nextScene({
      status: 200,
      chunks: [
        ev("message_start", { message: { usage: { input_tokens: 1 } } }),
        ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }), // 空初值不产帧
        ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }), // 透传
        ev("content_block_stop", { index: 0 }),
        ev("content_block_start", { index: 1, content_block: { type: "tool_use", id: "t1", name: "add" } }),
        ev("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"a"' } }),
        ev("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: ":1}" } }),
        ev("content_block_start", { index: 2, content_block: { type: "text", text: "mid" } }),
        ev("content_block_delta", { index: 2, delta: { type: "text_delta", text: "" } }), // 空文本跳过
        ev("content_block_stop", { index: 2 }),
        ev("content_block_start", { index: 3, content_block: { type: "tool_use", id: "t2", name: "sub" } }),
        ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } }),
        ev("message_stop"),
      ],
    });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks).toEqual([
      { type: "usage", usage: { input: 1 } },
      { type: "thinking-delta", text: "hmm" },
      { type: "tool-call-delta", index: 1, callId: "t1", name: "add" },
      { type: "tool-call-delta", index: 1, argumentsDelta: '{"a"' },
      { type: "tool-call-delta", index: 1, argumentsDelta: ":1}" },
      { type: "text-delta", text: "mid" },
      { type: "tool-call-delta", index: 3, callId: "t2", name: "sub" }, // 稀疏 index 原值（1/3 非重编号 0/1）
      { type: "usage", usage: { input: 1, output: 3 } },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("thinking 边界：空串/字段缺席/非字符串不产帧不崩；signature/redacted/未知 delta 跳过", async () => {
    srv = await startSceneServer();
    srv.nextScene({
      status: 200,
      chunks: [
        ev("message_start", { message: { usage: { input_tokens: 1 } } }),
        ev("content_block_start", { index: 0, content_block: { type: "thinking" } }), // 字段缺席
        ev("content_block_start", { index: 1, content_block: { type: "thinking", thinking: "" } }), // 空初值
        ev("content_block_start", { index: 2, content_block: { type: "thinking", thinking: 5 } }), // 非字符串
        ev("content_block_delta", { index: 3, delta: { type: "thinking_delta" } }), // 字段缺席
        ev("content_block_delta", { index: 4, delta: { type: "thinking_delta", thinking: "" } }), // 空串
        ev("content_block_delta", { index: 5, delta: { type: "thinking_delta", thinking: 7 } }), // 非字符串
        ev("content_block_delta", { index: 6, delta: { type: "signature_delta", signature: "sig" } }), // 签名
        ev("content_block_delta", { index: 7, delta: { type: "redacted_thinking", data: "x" } }), // redacted
        ev("content_block_delta", { index: 8, delta: { type: "mystery_delta" } }), // 未知
        ev("content_block_delta", { index: 9, delta: { type: "text_delta", text: "ok" } }),
        ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
        ev("message_stop"),
      ],
    });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks).toEqual([
      { type: "usage", usage: { input: 1 } },
      { type: "text-delta", text: "ok" },
      { type: "usage", usage: { input: 1, output: 2 } },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("思考交错：text→thinking→text 与双 thinking 块，帧序与到达序一致", async () => {
    srv = await startSceneServer();
    srv.nextScene({
      status: 200,
      chunks: [
        ev("message_start", { message: { usage: { input_tokens: 1 } } }),
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "a" } }),
        ev("content_block_start", { index: 1, content_block: { type: "thinking", thinking: "t1" } }),
        ev("content_block_delta", { index: 1, delta: { type: "thinking_delta", thinking: "-t2" } }),
        ev("content_block_stop", { index: 1 }),
        ev("content_block_start", { index: 2, content_block: { type: "thinking", thinking: "u1" } }), // 第二个 thinking 块
        ev("content_block_stop", { index: 2 }),
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "b" } }),
        ev("message_delta", { delta: { stop_reason: "end_turn" } }),
        ev("message_stop"),
      ],
    });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks).toEqual([
      { type: "usage", usage: { input: 1 } },
      { type: "text-delta", text: "a" },
      { type: "thinking-delta", text: "t1" },
      { type: "thinking-delta", text: "-t2" },
      { type: "thinking-delta", text: "u1" },
      { type: "text-delta", text: "b" },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it.each([
    ["end_turn → stop", "end_turn", { kind: "stop" }],
    ["tool_use → stop", "tool_use", { kind: "stop" }],
    ["stop_sequence → stop", "stop_sequence", { kind: "stop" }],
    ["pause_turn → stop", "pause_turn", { kind: "stop" }],
    ["max_tokens → max-tokens", "max_tokens", { kind: "max-tokens" }],
  ])("stop_reason %s", async (_name, reason, expected) => {
    srv = await startSceneServer();
    srv.nextScene({ status: 200, chunks: [ev("message_delta", { delta: { stop_reason: reason } }), ev("message_stop")] });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks.at(-1)).toEqual({ type: "finish", finish: expected });
  });

  it("refusal/sensitive → error finish 携带 explanation（缺省落 stop_reason）", async () => {
    srv = await startSceneServer();
    srv.nextScene({
      status: 200,
      chunks: [
        ev("message_delta", { delta: { stop_reason: "refusal", stop_details: { explanation: "policy blocked" } } }),
        ev("message_stop"),
      ],
    });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks.at(-1)).toEqual({ type: "finish", finish: { kind: "error", message: "policy blocked" } });

    srv?.nextScene({ status: 200, chunks: [ev("message_delta", { delta: { stop_reason: "sensitive" } }), ev("message_stop")] });
    const sensitive = await collect(adapter().stream(request()));
    expect(sensitive.at(-1)).toEqual({ type: "finish", finish: { kind: "error", message: "sensitive" } });
  });

  it("未知 stop_reason → stop（fail-open 落档）", async () => {
    srv = await startSceneServer();
    srv.nextScene({ status: 200, chunks: [ev("message_delta", { delta: { stop_reason: "brand_new_reason" } }), ev("message_stop")] });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks.at(-1)).toEqual({ type: "finish", finish: { kind: "stop" } });
  });

  it("usage 字段级合并：message_delta 只回 output 不归零 input（P8）；usage 缺席是 no-op", async () => {
    srv = await startSceneServer();
    srv.nextScene({
      status: 200,
      chunks: [
        ev("message_start", { message: { usage: { input_tokens: 9 } } }),
        ev("message_delta", { delta: { stop_reason: "end_turn" } }), // 无 usage：no-op
        ev("message_delta", { usage: { output_tokens: 4 } }), // 只回 output
        ev("message_stop"),
      ],
    });
    const chunks = await collect(adapter().stream(request()));
    const usageChunks = chunks.filter((c) => c.type === "usage");
    expect(usageChunks.at(-1)).toEqual({ type: "usage", usage: { input: 9, output: 4 } });
  });

  it("message_stop = 终止符：停读 + 连接释放（挂连接装置）+ trailing 忽略（P9）", async () => {
    srv = await startSceneServer();
    let connectionsClosed = 0;
    srv.onSocketClose(() => {
      connectionsClosed += 1;
    });
    srv.nextScene({
      status: 200,
      chunks: [
        ev("message_start", { message: { usage: { input_tokens: 1 } } }),
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "a" } }),
        ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
        ev("message_stop"),
      ],
      afterDone: { delayMs: 60, frame: ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "AFTER" } }) },
    });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks.some((c) => c.type === "text-delta" && c.text === "AFTER")).toBe(false); // trailing 不混入
    expect(chunks.at(-1)).toEqual({ type: "finish", finish: { kind: "stop" } });
    await new Promise((resolve) => {
      setTimeout(resolve, 120);
    });
    expect(connectionsClosed).toBe(1); // 客户端 cancel 释放（releaseLock 后 cancel 无效的回归）
  });

  it("finish 已发后 error 事件忽略（恰一 finish）；未发时 overloaded_error → code network", async () => {
    srv = await startSceneServer();
    srv.nextScene({
      status: 200,
      chunks: [
        ev("message_delta", { delta: { stop_reason: "end_turn" } }),
        ev("error", { error: { type: "overloaded_error", message: "overloaded" } }), // finish 后 → 忽略
        ev("message_stop"),
      ],
    });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks.filter((c) => c.type === "finish")).toEqual([{ type: "finish", finish: { kind: "stop" } }]); // stop 成立非 error

    srv?.nextScene({
      status: 200,
      chunks: [ev("content_block_start", { index: 0, content_block: { type: "text", text: "partial" } }), ev("error", { error: { type: "overloaded_error", message: "overloaded" } })],
    });
    const failed = await collect(adapter().stream(request()));
    expect(failed.at(-1)).toEqual({ type: "finish", finish: { kind: "error", message: "overloaded", code: "network" } });
  });

  it("截断流三态：无 finish 无 stop → network；有 finish 无 stop → 不再发 finish 且 usage 不丢", async () => {
    srv = await startSceneServer();
    srv.nextScene({ status: 200, chunks: [ev("content_block_start", { index: 0, content_block: { type: "text", text: "x" } })] });
    const truncated = await collect(adapter().stream(request()));
    expect(truncated.at(-1)).toEqual({ type: "finish", finish: { kind: "error", message: "stream ended without finish", code: "network" } });

    srv?.nextScene({
      status: 200,
      chunks: [ev("message_start", { message: { usage: { input_tokens: 5 } } }), ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })],
    });
    const finishedThenEof = await collect(adapter().stream(request()));
    expect(finishedThenEof.filter((c) => c.type === "finish")).toEqual([{ type: "finish", finish: { kind: "stop" } }]); // 恰一且是 stop
    expect(finishedThenEof.filter((c) => c.type === "usage").at(-1)).toEqual({ type: "usage", usage: { input: 5, output: 2 } }); // usage 不丢
  });

  it("ping 跳过；非 JSON 帧跳过（后续事件照常）；字节级撕裂拼接", async () => {
    srv = await startSceneServer();
    const frames = [
      ev("ping"),
      ev("message_start", { message: { usage: { input_tokens: 2 } } }),
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "héllo→" } }),
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "世界" } }),
      "data: not-json\n\n", // 非 JSON 帧：跳过不崩
      ev("message_delta", { delta: { stop_reason: "end_turn" } }),
      ev("message_stop"),
    ].join("");
    const bytes = Buffer.from(frames);
    // 字节级切片：行边界与多字节 UTF-8 序列都被真正拆开
    srv.nextScene({ status: 200, chunks: Array.from({ length: bytes.length }, (_, i) => bytes.subarray(i, i + 1)) });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks.filter((c) => c.type === "text-delta").map((c) => (c as { text: string }).text).join("")).toBe("héllo→世界");
    expect(chunks.at(-1)).toEqual({ type: "finish", finish: { kind: "stop" } }); // 非 JSON 帧后照常收尾
  });

  it("非 2xx → http-<status>；连接拒绝 → network；请求前 abort → throw", async () => {
    srv = await startSceneServer();
    srv.nextScene({ status: 401, chunks: [JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } })] });
    const unauthorized = await collect(adapter().stream(request()));
    expect(unauthorized[0]).toMatchObject({ type: "finish", finish: { kind: "error", code: "http-401" } });

    const refused = createAnthropicCompatAdapter({ baseUrl: "http://127.0.0.1:1", apiKey: "k" });
    const refusedChunks = await collect(refused.stream(request()));
    expect(refusedChunks[0]).toMatchObject({ type: "finish", finish: { code: "network" } });

    await srv?.close(); // 重赋值前关旧句柄（防泄漏）
    srv = await startSceneServer();
    const controller = new AbortController();
    controller.abort();
    await expect(collect(adapter().stream(request({ signal: controller.signal })))).rejects.toThrow();
  });

  it("读体中断（分片已产出后断连）→ 分片保序 + network finish 收尾", async () => {
    srv = await startSceneServer();
    srv.nextScene({
      status: 200,
      chunks: [ev("content_block_start", { index: 0, content_block: { type: "text", text: "par" } }), ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "tial" } })],
      destroyAfterMs: 40,
    });
    const chunks = await collect(adapter().stream(request()));
    expect(chunks[0]).toEqual({ type: "text-delta", text: "par" });
    expect(chunks[1]).toEqual({ type: "text-delta", text: "tial" });
    expect(chunks.at(-1)).toMatchObject({ type: "finish", finish: { kind: "error", code: "network" } });
  });
});
