import { describe, expect, it } from "vitest";
import { anchorVerdictOf } from "../executor-worker/settle-anchor.ts";

const EVENTS = [
  { seq: 0, type: "turn/start", data: { turn: 0 } },
  { seq: 5, type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } },
] as const;

describe("anchorVerdictOf idle 守卫契约（两形态同判）", () => {
  it("running：无属己 turn/end → ok:true（不误报 queue-cleared——B.P2-1 兜底）", () => {
    const verdict = anchorVerdictOf(EVENTS, { anchorTurn: 1, fromSeq: 0, agent: { status: "running" } });
    expect(verdict).toEqual({ ok: true });
  });

  it("idle：无属己 turn/end → queue-cleared", () => {
    const verdict = anchorVerdictOf(EVENTS, { anchorTurn: 1, fromSeq: 0, agent: { status: "idle" } });
    expect(verdict).toEqual({ ok: false, reason: "queue-cleared" });
  });

  it("无 agent（旧调用形态）：保持 queue-cleared 判别", () => {
    const verdict = anchorVerdictOf(EVENTS, { anchorTurn: 1, fromSeq: 0 });
    expect(verdict).toEqual({ ok: false, reason: "queue-cleared" });
  });

  it("有属己 turn/end：守卫不影响裁决（idle/running 同判）", () => {
    expect(anchorVerdictOf(EVENTS, { anchorTurn: 0, fromSeq: 0, agent: { status: "idle" } })).toEqual({ ok: true });
    expect(anchorVerdictOf(EVENTS, { anchorTurn: 0, fromSeq: 0, agent: { status: "running" } })).toEqual({ ok: true });
  });
});
