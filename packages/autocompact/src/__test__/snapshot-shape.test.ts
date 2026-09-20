// 快照形态夹具（docs/TAIL-SNAPSHOT-CHANNEL.md 评审处置 F2/M4）：isTurnStartNode 谓词
// 变更在 autocompact 五消费点自动传播——四面行为锚（L2 对齐 / boxSegment 起点 /
// conservativeBoundarySeq 覆盖边界 / lastTurnStartIndex 在飞轮边界）。快照不是用户
// 真轮：不作对齐目标、不作段起点、不计在飞轮边界；落在锚后首真轮之前的快照被划入
// 保守覆盖前缀（自愈环兜底——缺席重注入）。

import { describe, expect, it } from "vitest";
import type { SurfaceNode } from "@x-harness/session";
import { snapshotEnvelope } from "@x-harness/agent-loop";
import { alignDownToTurnStart } from "../escalator.ts";
import { boxSegment, conservativeBoundarySeq } from "../checkpoint.ts";
import { lastTurnStartIndex } from "../scavenger.ts";
import { assistantNode, userNode } from "./helpers.ts";

/** system/message 节点（helpers 未导出——本文件自铸最小形态） */
const systemNode = (seq: number, text: string): SurfaceNode =>
  ({ seq, event: { type: "system/message", seq, time: 1, data: { turn: 0, step: 0, text }, surfaceOp: "append" } }) as unknown as SurfaceNode;

const SNAP_DATE = snapshotEnvelope("date", "Today's date: 2026-09-21");
const SNAP_TYPES = snapshotEnvelope("agent-types", "<system-reminder>\nAvailable agent types:\n- worker — d\n</system-reminder>");

describe("快照形态 × autocompact 谓词消费点（四面夹具）", () => {
  it("escalator alignDownToTurnStart：快照不作 L2 切口对齐目标", () => {
    const nodes = [userNode(0, "turn one"), userNode(1, SNAP_DATE), userNode(2, "turn two"), assistantNode(3, "reply")];
    expect(alignDownToTurnStart(nodes, 1)).toBe(0); // ceiling 覆盖快照（idx1）——对齐仍落真轮起点 0
    expect(alignDownToTurnStart(nodes, 2)).toBe(2); // 覆盖真轮起点时对齐到它
  });

  it("checkpoint boxSegment：快照不作段起点（真轮起点对齐跳过快照）", () => {
    const nodes = [userNode(0, SNAP_TYPES), userNode(1, "turn one"), assistantNode(2, "reply"), userNode(3, "turn two")];
    const segment = boxSegment({ nodes, from: 0, lastTurnStart: 3, tokenBudget: 100_000 });
    expect(segment).toEqual({ start: 1, end: 3 }); // 起点=真轮起点 1，锚后快照（idx0）被排除在段外
  });

  it("checkpoint conservativeBoundarySeq：锚后首真轮之前的快照划入保守覆盖前缀（自愈环兜底）", () => {
    const withSnap = [systemNode(0, "system"), userNode(1, SNAP_DATE), userNode(2, "turn one"), assistantNode(3, "reply")];
    expect(conservativeBoundarySeq(withSnap)).toBe(1); // 边界=首真轮（seq2）前一节点=快照 seq——保守方向
    const withoutSnap = [systemNode(0, "system"), userNode(1, "turn one"), assistantNode(2, "reply")];
    expect(conservativeBoundarySeq(withoutSnap)).toBe(0); // 无快照：边界=锚点 seq（既有行为不变）
  });

  it("scavenger lastTurnStartIndex：快照不计在飞轮边界", () => {
    const nodes = [userNode(0, "turn one"), userNode(1, SNAP_DATE), assistantNode(2, "reply")];
    expect(lastTurnStartIndex(nodes)).toBe(0); // 末真轮起点=0（快照不算——其前结果不因它而提前可清理）
    const leading = [userNode(0, "turn one"), userNode(1, SNAP_DATE), userNode(2, "turn two")];
    expect(lastTurnStartIndex(leading)).toBe(2);
  });
});
