// 流累积与结算单元（docs/AGENT-LOOP-DRIVER §1.4）：tool-call-delta 分片聚积/兜底值/
// finish 三态/空结算/非 Error 抛值。

import { describe, expect, it } from "vitest";
import { settleStream, StreamAccumulator } from "../stream.ts";

describe("StreamAccumulator（docs/AGENT-LOOP-DRIVER §1.4）", () => {
  it("text-delta 拼接；空文本不产 text 块", () => {
    const accum = new StreamAccumulator();
    accum.push({ type: "text-delta", text: "a" });
    accum.push({ type: "text-delta", text: "b" });
    expect(accum.text).toBe("ab");
    expect(accum.textBlock).toEqual([{ type: "text", text: "ab" }]);

    const empty = new StreamAccumulator();
    expect(empty.textBlock).toEqual([]);
    expect(empty.hasContent).toBe(false);
  });

  it("tool-call-delta 分片聚积：同 index 追加 arguments、callId/name 后到覆盖", () => {
    const accum = new StreamAccumulator();
    accum.push({ type: "tool-call-delta", index: 0, argumentsDelta: '{"a"' });
    accum.push({ type: "tool-call-delta", index: 0, argumentsDelta: ":1}" });
    accum.push({ type: "tool-call-delta", index: 0, callId: "c9", name: "t" });
    expect(accum.toolUseBlocks).toEqual([{ type: "tool_use", callId: "c9", name: "t", input: '{"a":1}' }]);
    expect(accum.hasContent).toBe(true);
  });

  it("callId/name 兜底：缺席时 call-N 与空串；多 index 按序输出", () => {
    const accum = new StreamAccumulator();
    accum.push({ type: "tool-call-delta", index: 1, argumentsDelta: "{}" });
    accum.push({ type: "tool-call-delta", index: 0, argumentsDelta: "{}" });
    expect(accum.toolUseBlocks).toEqual([
      { type: "tool_use", callId: "call-0", name: "", input: "{}" },
      { type: "tool_use", callId: "call-1", name: "", input: "{}" },
    ]);
  });

  it("usage 捕获快照", () => {
    const accum = new StreamAccumulator();
    expect(accum.usageSnapshot).toBeUndefined();
    accum.push({ type: "usage", usage: { input: 3, output: 4 } });
    expect(accum.usageSnapshot).toEqual({ input: 3, output: 4 });
  });

  it("thinking-delta 忽略：不进 text/落账块、不救空结算（docs/THINKING-STREAM.md 契约 5）", () => {
    const accum = new StreamAccumulator();
    accum.push({ type: "thinking-delta", text: "hmm" });
    expect(accum.text).toBe("");
    expect(accum.textBlock).toEqual([]);
    expect(accum.toolUseBlocks).toEqual([]);
    expect(accum.hasContent).toBe(false);
  });
});

describe("settleStream（docs/AGENT-LOOP-DRIVER §1.4）", () => {
  it("finish stop 有内容 → message stop", () => {
    const accum = new StreamAccumulator();
    accum.push({ type: "text-delta", text: "x" });
    accum.push({ type: "finish", finish: { kind: "stop" } });
    expect(settleStream(accum, undefined, false)).toEqual({ kind: "message", stopReason: "stop" });
  });

  it("finish max-tokens → message max-tokens（粘性源）", () => {
    const accum = new StreamAccumulator();
    accum.push({ type: "text-delta", text: "x" });
    accum.push({ type: "finish", finish: { kind: "max-tokens" } });
    expect(settleStream(accum, undefined, false)).toEqual({ kind: "message", stopReason: "max-tokens" });
  });

  it("finish error 带 code → `code:message`；无 code → message", () => {
    const withCode = new StreamAccumulator();
    withCode.push({ type: "finish", finish: { kind: "error", message: "boom", code: "E503" } });
    expect(settleStream(withCode, undefined, false)).toEqual({ kind: "attempt", error: "E503:boom", code: "E503" });

    const bare = new StreamAccumulator();
    bare.push({ type: "finish", finish: { kind: "error", message: "boom" } });
    expect(settleStream(bare, undefined, false)).toEqual({ kind: "attempt", error: "boom" });

    // retryAfterMs 快车道透传（docs/LLM.md §1.2）
    const throttled = new StreamAccumulator();
    throttled.push({ type: "finish", finish: { kind: "error", message: "slow down", code: "http-429", retryAfterMs: 2500 } });
    expect(settleStream(throttled, undefined, false)).toEqual({ kind: "attempt", error: "http-429:slow down", code: "http-429", retryAfterMs: 2500 });
  });

  it("流无 finish → attempt；finish stop 零内容 → 空结算 attempt", () => {
    const noFinish = new StreamAccumulator();
    noFinish.push({ type: "text-delta", text: "x" });
    // 无 finish 的截断流归 network（可重试）——驱动兜底对违约适配器同口径
    expect(settleStream(noFinish, undefined, false)).toEqual({ kind: "attempt", error: "stream ended without finish", code: "network" });

    const emptyStop = new StreamAccumulator();
    emptyStop.push({ type: "finish", finish: { kind: "stop" } });
    expect(settleStream(emptyStop, undefined, false)).toEqual({ kind: "attempt", error: "empty completion" });

    // thinking-only 不救空结算：思考只广播不落账，stop 无正文/工具仍判空（docs/THINKING-STREAM.md 契约 5）
    const thinkingOnly = new StreamAccumulator();
    thinkingOnly.push({ type: "thinking-delta", text: "hmm" });
    thinkingOnly.push({ type: "finish", finish: { kind: "stop" } });
    expect(settleStream(thinkingOnly, undefined, false)).toEqual({ kind: "attempt", error: "empty completion" });
  });

  it("thinking-only + finish max-tokens → message max-tokens（空 content——既有 max-tokens 前置语义）", () => {
    const accum = new StreamAccumulator();
    accum.push({ type: "thinking-delta", text: "hmm" });
    accum.push({ type: "finish", finish: { kind: "max-tokens" } });
    expect(settleStream(accum, undefined, false)).toEqual({ kind: "message", stopReason: "max-tokens" });
    expect(accum.textBlock).toEqual([]);
  });

  it("流抛：abort 且有内容 → interrupted message；否则 attempt（Error 与非 Error 文案）", () => {
    const partial = new StreamAccumulator();
    partial.push({ type: "text-delta", text: "partial" });
    expect(settleStream(partial, new Error("cut"), true)).toEqual({ kind: "message", stopReason: "stop", interrupted: true });

    const bare = new StreamAccumulator();
    expect(settleStream(bare, new Error("net down"), false)).toEqual({ kind: "attempt", error: "net down" });
    expect(settleStream(bare, "raw string failure", false)).toEqual({ kind: "attempt", error: "raw string failure" });
  });
});
