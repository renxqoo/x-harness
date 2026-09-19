// pi-context 映射矩阵（docs/LLM-PI.md 测试口径）：system 顶层化、四角色转换、
// tool_use input 解析降级三态、toolName 前文回查、空 user 跳过、工具表直传。

import { describe, expect, it } from "vitest";
import { toPiContext } from "../pi-context.ts";
import type { LlmRequest } from "../types.ts";

const META = { api: "anthropic-messages", provider: "anthropic", model: "m1" } as const;

function request(messages: unknown[]): LlmRequest {
  return { model: "m1", tools: [], messages: messages as never, signal: new AbortController().signal };
}

describe("toPiContext（docs/LLM-PI.md 契约 2）", () => {
  it("system 顶层化：多条 join \\n\\n；四角色转换；toolResult 还原独立消息", () => {
    const ctx = toPiContext(
      request([
        { role: "system", text: "sys-a" },
        { role: "system", text: "sys-b" },
        { role: "user", content: [{ type: "text", text: "do it" }] },
        { role: "assistant", content: [{ type: "tool_use", callId: "c1", name: "add", input: '{"a":1}' }] },
        { role: "tool", callId: "c1", content: "3" },
        { role: "user", content: [{ type: "text", text: "steer" }] },
      ]),
      META,
    );
    expect(ctx.systemPrompt).toBe("sys-a\n\nsys-b");
    expect(ctx.tools).toBeUndefined();
    expect(ctx.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "do it" }], timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "add", arguments: { a: 1 } }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "m1",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "add", // 前文 tool_use 回查
        content: [{ type: "text", text: "3" }],
        isError: false,
        timestamp: 0,
      },
      { role: "user", content: [{ type: "text", text: "steer" }], timestamp: 0 },
    ]);
  });

  it("tool_use input 解析降级：失败/数组/null 原始值 → {}", () => {
    const ctx = toPiContext(
      request([
        {
          role: "assistant",
          content: [
            { type: "tool_use", callId: "a", name: "t", input: "not json" },
            { type: "tool_use", callId: "b", name: "t", input: "[1,2]" },
            { type: "tool_use", callId: "c", name: "t", input: "null" },
            { type: "tool_use", callId: "d", name: "t", input: "5" },
          ],
        },
      ]),
      META,
    );
    const calls = (ctx.messages[0] as { content: Array<{ arguments: unknown }> }).content;
    expect(calls.map((call) => call.arguments)).toEqual([{}, {}, {}, {}]);
  });

  it("toolName 回查缺席 → \"unknown\"；isError 透传；tool content 缺席归空串", () => {
    const ctx = toPiContext(request([{ role: "tool", callId: "orphan", content: undefined as never }]), META);
    expect(ctx.messages).toEqual([
      {
        role: "toolResult",
        toolCallId: "orphan",
        toolName: "unknown",
        content: [{ type: "text", text: "" }],
        isError: false,
        timestamp: 0,
      },
    ]);
    const ctx2 = toPiContext(
      request([
        { role: "assistant", content: [{ type: "tool_use", callId: "x", name: "t", input: "{}" }] },
        { role: "tool", callId: "x", content: "boom", isError: true },
      ]),
      META,
    );
    expect((ctx2.messages[1] as { isError: boolean }).isError).toBe(true);
  });

  it("空 user 整条跳过（无 text 块不换 400）；assistant 空块跳过", () => {
    const ctx = toPiContext(
      request([
        { role: "user", content: [{ type: "text", text: "" }] },
        { role: "assistant", content: [] },
        { role: "user", content: [{ type: "text", text: "only" }] },
      ]),
      META,
    );
    expect(ctx.messages).toEqual([{ role: "user", content: [{ type: "text", text: "only" }], timestamp: 0 }]);
  });

  it("工具表直传：name/description/parameters；空工具不落键", () => {
    const withTools = toPiContext(
      {
        ...request([{ role: "user", content: [{ type: "text", text: "q" }] }]),
        tools: [
          { name: "add", inputSchema: { type: "object" } },
          { name: "sub", description: "减", inputSchema: { type: "object", properties: {} } },
        ] as never,
      },
      META,
    );
    expect(withTools.tools).toEqual([
      { name: "add", description: "", parameters: { type: "object" } },
      { name: "sub", description: "减", parameters: { type: "object", properties: {} } },
    ]);
    expect(toPiContext(request([{ role: "user", content: [{ type: "text", text: "q" }] }]), META).tools).toBeUndefined();
  });

  it("assistant text + tool_use 混合块序保持；垃圾块跳过", () => {
    const ctx = toPiContext(
      request([
        {
          role: "assistant",
          content: [
            { type: "text", text: "先说" },
            { type: "mystery" },
            { type: "tool_use", callId: "c9", name: "t", input: "{}" },
          ],
        },
      ]),
      META,
    );
    expect((ctx.messages[0] as { content: Array<{ type: string }> }).content.map((b) => b.type)).toEqual(["text", "toolCall"]);
  });
});
