import { describe, expect, it } from "vitest";
import type { SurfaceNode } from "@x-harness/session";
import { snapshotEnvelope } from "@x-harness/agent-loop";
import { alignDownToTurnStart } from "../escalator.ts";
import { boxSegment, conservativeBoundarySeq } from "../checkpoint.ts";
import { lastTurnStartIndex } from "../scavenger.ts";
import { assistantNode, userNode } from "./helpers.ts";

const systemNode = (seq: number, text: string): SurfaceNode =>
  ({ seq, event: { type: "system/message", seq, time: 1, data: { turn: 0, step: 0, text }, surfaceOp: "append" } }) as unknown as SurfaceNode;

const SNAP_DATE = snapshotEnvelope("date", "Today's date: 2026-09-21");
const SNAP_TYPES = snapshotEnvelope("agent-types", "<system-reminder>\nAvailable agent types:\n- worker — d\n</system-reminder>");

describe("快照形态 × autocompact 谓词消费点（四面夹具）", () => {
  it("escalator alignDownToTurnStart：快照不作 L2 切口对齐目标", () => {
    const nodes = [userNode(0, "turn one"), userNode(1, SNAP_DATE), userNode(2, "turn two"), assistantNode(3, "reply")];
    expect(alignDownToTurnStart(nodes, 1)).toBe(0);
    expect(alignDownToTurnStart(nodes, 2)).toBe(2);
  });

  it("checkpoint boxSegment：快照不作段起点（真轮起点对齐跳过快照）", () => {
    const nodes = [userNode(0, SNAP_TYPES), userNode(1, "turn one"), assistantNode(2, "reply"), userNode(3, "turn two")];
    const segment = boxSegment({ nodes, from: 0, lastTurnStart: 3, tokenBudget: 100_000 });
    expect(segment).toEqual({ start: 1, end: 3 });
  });

  it("checkpoint conservativeBoundarySeq：锚后首真轮之前的快照划入保守覆盖前缀（自愈环兜底）", () => {
    const withSnap = [systemNode(0, "system"), userNode(1, SNAP_DATE), userNode(2, "turn one"), assistantNode(3, "reply")];
    expect(conservativeBoundarySeq(withSnap)).toBe(1);
    const withoutSnap = [systemNode(0, "system"), userNode(1, "turn one"), assistantNode(2, "reply")];
    expect(conservativeBoundarySeq(withoutSnap)).toBe(0);
  });

  it("scavenger lastTurnStartIndex：快照不计在飞轮边界", () => {
    const nodes = [userNode(0, "turn one"), userNode(1, SNAP_DATE), assistantNode(2, "reply")];
    expect(lastTurnStartIndex(nodes)).toBe(0);
    const leading = [userNode(0, "turn one"), userNode(1, SNAP_DATE), userNode(2, "turn two")];
    expect(lastTurnStartIndex(leading)).toBe(2);
  });
});
