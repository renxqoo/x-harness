// 内部消息子系统本体（docs/AGENT-MESSAGE.md §1/§2/§6）：构造器、形状门正反例、
// 投影 user 角色、表面第 5 类入投影、既有四类零扰回归。

import { describe, expect, it } from "vitest";
import { agentMessageData, isAgentContent, isAgentDirective } from "../agent-message.ts";
import { validateSessionEvents } from "../gates.ts";
import { anchorIndexOf, projectSurface, surfaceToMessages } from "../surface.ts";
import type { SessionEvent, SurfaceOp } from "../types.ts";

function surfaceEvent(spec: { seq: number; type: "agent/message"; data: unknown; op: SurfaceOp }): SessionEvent<"agent/message"> {
  return { type: spec.type, seq: spec.seq, time: 1, data: spec.data, surfaceOp: spec.op } as unknown as SessionEvent<"agent/message">;
}

function agentMessageEvent(seq: number, fields?: { source?: string; kind?: string; content?: unknown }): SessionEvent<"agent/message"> {
  return surfaceEvent({
    seq,
    type: "agent/message",
    data: {
      turn: 0,
      step: 1,
      source: fields?.source ?? "output-continuation",
      kind: fields?.kind ?? "directive",
      content: fields?.content ?? [{ type: "text", text: "继续写" }],
    },
    op: "append",
  });
}

describe("agentMessageData / 消费谓词（AGENT-MESSAGE.md §2 单一真相）", () => {
  it("构造器产出闭形 data（content 拷贝防外部可变引用）", () => {
    const content = [{ type: "text" as const, text: "x" }];
    const data = agentMessageData({ turn: 1, step: 2, source: "output-continuation", kind: "directive", content });
    expect(data).toEqual({ turn: 1, step: 2, source: "output-continuation", kind: "directive", content: [{ type: "text", text: "x" }] });
    expect(data.content).not.toBe(content);
  });

  it("谓词按 kind 二分；非 agent/message 事件恒 false", () => {
    const directive = agentMessageEvent(0);
    const content = agentMessageEvent(1, { kind: "content" });
    expect(isAgentDirective(directive)).toBe(true);
    expect(isAgentContent(directive)).toBe(false);
    expect(isAgentDirective(content)).toBe(false);
    expect(isAgentContent(content)).toBe(true);
    const foreign = { type: "user/message", seq: 2, time: 1, data: { turn: 0, step: 0, content: [] }, surfaceOp: "append" } as never as SessionEvent;
    expect(isAgentDirective(foreign)).toBe(false);
    expect(isAgentContent(foreign)).toBe(false);
  });
});

describe("agent/message 表面投影（第 5 类——AGENT-MESSAGE.md §1）", () => {
  it("append 入投影且映射 user 角色（协议事实：provider 只有 user/assistant）", () => {
    const nodes = projectSurface([
      agentMessageEvent(0, { kind: "content", content: [{ type: "text", text: "子代理报告" }] }),
      agentMessageEvent(1),
    ]);
    expect(nodes).toHaveLength(2);
    expect(surfaceToMessages(nodes)).toEqual([
      { role: "user", content: [{ type: "text", text: "子代理报告" }] },
      { role: "user", content: [{ type: "text", text: "继续写" }] },
    ]);
  });

  it("非切口锚点：data 无顶层 text 字段，不干扰 anchorIndexOf 语义", () => {
    const nodes = projectSurface([agentMessageEvent(0)]);
    expect(anchorIndexOf(nodes)).toBe(-1);
  });
});

describe("agent/message 形状门（gates——AGENT-MESSAGE.md §1 词表纪律）", () => {
  it("正形过门；kind 垃圾值 / source 空串 / image 块 / 缺字段拒", () => {
    const ok = validateSessionEvents([agentMessageEvent(0)]);
    expect(ok).toBeUndefined();
    for (const bad of [
      agentMessageEvent(0, { kind: "control" }), // 闭集外（历史名——钉死拒）
      agentMessageEvent(0, { kind: "meta" }),
      agentMessageEvent(0, { source: "" }),
      agentMessageEvent(0, { content: [{ type: "image", data: "abc", mediaType: "image/png" }] }),
      { type: "agent/message", seq: 0, time: 1, data: { turn: 0, step: 1, source: "s", kind: "directive" } }, // 缺 content
    ]) {
      expect(validateSessionEvents([bad as never])).toMatch(/^corrupt-envelope:0:shape:agent\/message$/);
    }
  });
});
