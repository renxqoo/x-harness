import { describe, expect, it } from "vitest";
import { interruptedTurnClosers } from "../repair.ts";
import type { SessionEvent } from "@x-harness/session";

interface EvSpec {
  readonly seq: number;
  readonly type: string;
  readonly data: unknown;
  readonly surfaceOp?: "append";
}

function ev(spec: EvSpec): SessionEvent {
  return { type: spec.type, seq: spec.seq, time: 100, data: spec.data as never, ...(spec.surfaceOp !== undefined ? { surfaceOp: spec.surfaceOp } : {}) } as SessionEvent;
}

const toolUse = (callId: string): { type: "tool_use"; callId: string; name: string; input: string } => ({
  type: "tool_use",
  callId,
  name: "t",
  input: "{}",
});

describe("interruptedTurnClosers（docs/AGENT-LOOP-DRIVER §1.6，DSH repair.spec 承接）", () => {
  it("平衡卷零修复；空卷零修复", () => {
    expect(interruptedTurnClosers([])).toEqual([]);
    const balanced = [
      ev({ seq: 0, type: "turn/start", data: { turn: 0 } }),
      ev({ seq: 1, type: "step/start", data: { turn: 0, step: 0 } }),
      ev({ seq: 2, type: "assistant/message", data: { turn: 0, step: 0, content: [] }, surfaceOp: "append" }),
      ev({ seq: 3, type: "step/end", data: { turn: 0, step: 0 } }),
      ev({ seq: 4, type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } }),
    ];
    expect(interruptedTurnClosers(balanced)).toEqual([]);
  });

  it("悬空 tool_use 两态：有 tool/call → outcome unknown；无 → not started", () => {
    const withCall = [
      ev({ seq: 0, type: "turn/start", data: { turn: 0 } }),
      ev({ seq: 1, type: "step/start", data: { turn: 0, step: 0 } }),
      ev({ seq: 2, type: "assistant/message", data: { turn: 0, step: 0, content: [toolUse("c1")] }, surfaceOp: "append" }),
      ev({ seq: 3, type: "tool/call", data: { turn: 0, step: 0, callId: "c1", name: "t", arguments: "{}" } }),
    ];
    const closers = interruptedTurnClosers(withCall);
    const result = closers[0];
    expect(result?.type).toBe("tool/result");
    const data = result?.data as { content?: string; isError?: true } | undefined;
    expect(data?.content).toContain("outcome unknown");
    expect(data?.isError).toBe(true);
    expect(result).toHaveProperty("surfaceOp", "append");
    expect(closers[1]).toMatchObject({ type: "step/end", data: { turn: 0, step: 0 } });
    expect(closers[2]).toMatchObject({ type: "turn/end", data: { turn: 0, reason: { kind: "interrupted" } } });

    const withoutCall = [
      ev({ seq: 0, type: "turn/start", data: { turn: 0 } }),
      ev({ seq: 1, type: "assistant/message", data: { turn: 0, step: 0, content: [toolUse("c2")] }, surfaceOp: "append" }),
    ];
    const first = interruptedTurnClosers(withoutCall)[0]?.data as { content?: string } | undefined;
    expect(first?.content).toContain("not started");
  });

  it("已有结果的 tool_use 不再合成；多未应答按日志顺序", () => {
    const log = [
      ev({ seq: 0, type: "turn/start", data: { turn: 0 } }),
      ev({ seq: 1, type: "assistant/message", data: { turn: 0, step: 0, content: [toolUse("a"), toolUse("b")] }, surfaceOp: "append" }),
      ev({ seq: 2, type: "tool/result", data: { turn: 0, step: 0, callId: "a", content: "ok" }, surfaceOp: "append" }),
    ];
    const closers = interruptedTurnClosers(log);
    expect(closers.filter((c) => c.type === "tool/result")).toHaveLength(1);
    const data = closers[0]?.data as { callId?: string } | undefined;
    expect(data?.callId).toBe("b");
  });

  it("claim 回灌：末次 user/message 之后的 claim 连续段，last-insert-wins；旧 claim 不误伤", () => {
    const insertA = { op: "insert" as const, target: "next-turn" as const, entries: [{ id: "x1", content: [{ type: "text", text: "v1" }] }] };
    const insertA2 = { op: "insert" as const, target: "next-turn" as const, entries: [{ id: "x1", content: [{ type: "text", text: "v2" }] }] };
    const log = [
      ev({ seq: 0, type: "agent/inbox/spliced", data: insertA }),
      ev({ seq: 1, type: "agent/inbox/spliced", data: { op: "claim", target: "next-turn", turn: 0, claimed: ["x1"] } }),
      ev({ seq: 2, type: "user/message", data: { turn: 0, step: 0, content: [] }, surfaceOp: "append" }), // 旧 claim 已消费
      ev({ seq: 3, type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } }),
      ev({ seq: 4, type: "turn/start", data: { turn: 1 } }),
      ev({ seq: 5, type: "agent/inbox/spliced", data: insertA2 }),
      ev({ seq: 6, type: "agent/inbox/spliced", data: { op: "claim", target: "next-turn", turn: 1, claimed: ["x1"] } }),
      // 崩溃：claim 后无 user/message
    ];
    const closers = interruptedTurnClosers(log);
    const reinsert = closers.find((c) => c.type === "agent/inbox/spliced");
    const entries = (reinsert?.data as unknown as { entries?: Array<{ content: Array<{ text: string }> }> } | undefined)?.entries ?? [];
    expect(entries[0]?.content[0]?.text).toBe("v2");
    expect(closers.some((c) => c.type === "turn/end")).toBe(true);
  });

  it("clear 撤销其后 claims 的回灌资格", () => {
    const insert = { op: "insert" as const, target: "next-turn" as const, entries: [{ id: "y", content: [] }] };
    const log = [
      ev({ seq: 0, type: "agent/inbox/spliced", data: insert }),
      ev({ seq: 1, type: "agent/inbox/spliced", data: { op: "claim", target: "next-turn", turn: 0, claimed: ["y"] } }),
      ev({ seq: 2, type: "agent/inbox/spliced", data: { op: "clear", reason: "user" } }),
    ];
    expect(interruptedTurnClosers(log).some((c) => c.type === "agent/inbox/spliced")).toBe(false);
  });
});
