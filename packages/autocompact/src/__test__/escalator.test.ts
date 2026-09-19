// L2 升级（对照参照系 escalator.test 语义；落账面改写为位置区间 replace 前缀）。

import { describe, expect, it } from "vitest";
import type { SurfaceNode } from "@x-harness/session";
import { AUTO_CONTINUATION_NOTE } from "@x-harness/compaction";
import { alignDownToTurnStart, escalateL2, ledgerReadyForL2 } from "../escalator.ts";
import { emptyCheckpointState } from "../checkpoint.ts";
import type { CheckpointState } from "../checkpoint.ts";
import { emptyLedger, parseLedgerPatch } from "../ledger.ts";
import { assistantNode, makeWorld, seedTurn, sid, textOf, userNode } from "./helpers.ts";

const LEDGER = parseLedgerPatch("<goals>\nship-it\n</goals>\n<current>\nmid work\n</current>") ?? emptyLedger();

function stateWithLedger(): CheckpointState {
  const state = emptyCheckpointState();
  state.ledger = LEDGER;
  return state;
}

/** [u0 a1 u2 a3 u4 a5]：三轮文本 */
function ladderNodes(tokens: number): SurfaceNode[] {
  return [
    userNode(0, textOf(tokens)),
    assistantNode(1, textOf(tokens)),
    userNode(2, textOf(tokens)),
    assistantNode(3, textOf(tokens)),
    userNode(4, textOf(tokens)),
    assistantNode(5, textOf(tokens)),
  ];
}

describe("ledgerReadyForL2 / alignDownToTurnStart", () => {
  it("熔断/空账本 → false；ceiling 之下最近真轮起点；无候选 → undefined", () => {
    const broken = stateWithLedger();
    broken.broken = true;
    expect(ledgerReadyForL2(broken)).toBe(false);
    expect(ledgerReadyForL2(emptyCheckpointState())).toBe(false);
    expect(ledgerReadyForL2(stateWithLedger())).toBe(true);
    const nodes = ladderNodes(1);
    expect(alignDownToTurnStart(nodes, 4)).toBe(4);
    expect(alignDownToTurnStart(nodes, 3)).toBe(2);
    expect(alignDownToTurnStart(nodes, 1)).toBe(0); // u0 即首个真轮起点
    expect(alignDownToTurnStart([assistantNode(0, "a"), assistantNode(1, "b")], 1)).toBeUndefined(); // 无候选
  });
});

describe("escalateL2", () => {
  it("零 LLM 落账：账本+注入语前缀替换、覆盖边界重锚、armed 复位、取消在飞作业", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("l2") });
      if (!made.ok) throw new Error(made.reason);
      const session = made.value;
      for (let turn = 0; turn < 8; turn += 1) {
        seedTurn(session, { turn, user: textOf(2_000), assistant: { text: textOf(2_000), usage: { input: 10, output: 1 } } });
      }
      const state = stateWithLedger();
      state.armed = true;
      state.coveredSeq = session.surface().at(-2)?.seq ?? -1; // 账本已覆盖全前缀（fold 恢复形态）
      const result = escalateL2({ state, session, nodes: session.surface(), effectiveWindow: 900, ledgerBudgetTokens: 200, emit: () => {} });
      expect(result.ok).toBe(true);
      expect(world.llm.calls).toHaveLength(0); // 零 LLM
      const head = session.deriveMessages()[0] as { content: ReadonlyArray<{ text: string }> };
      const text = head.content[0]?.text ?? "";
      expect(text).toContain("<goals>");
      expect(text).toContain("ship-it");
      expect(text).toContain(AUTO_CONTINUATION_NOTE);
      expect(state.armed).toBe(false);
      expect(state.coveredSeq).toBeGreaterThan(-1); // 重锚到新投影首个真轮起点
      const replaceEvents = session.events().filter((e) => e.type === "user/message" && typeof e.surfaceOp === "object");
      expect(replaceEvents).toHaveLength(1);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("覆盖域守卫：切口钳到账本覆盖边界（未收编前缀不被零 LLM 替换）", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("l2-guard") });
      if (!made.ok) throw new Error(made.reason);
      const session = made.value;
      for (let turn = 0; turn < 8; turn += 1) {
        seedTurn(session, { turn, user: textOf(2_000), assistant: { text: textOf(2_000), usage: { input: 10, output: 1 } } });
      }
      const state = stateWithLedger();
      const nodes = session.surface();
      state.coveredSeq = nodes[1]?.seq ?? -1; // 仅覆盖 turn-0
      const result = escalateL2({ state, session, nodes, effectiveWindow: 900, ledgerBudgetTokens: 200, emit: () => {} });
      expect(result.ok).toBe(true);
      const kept = session.surface().length;
      expect(kept).toBeGreaterThanOrEqual(nodes.length - 3); // 只替换已覆盖前缀（宽预算不吞未收编区）
    } finally {
      await world.ctx.dispose();
    }
  });

  it("factor 收缩不放大保留区（keep 单调不减）", async () => {
    const results: number[] = [];
    for (const factor of [1, 0.5]) {
      const world = await makeWorld();
      try {
        const made = await world.store.create({ id: sid(`l2-f${String(factor)}`) });
        if (!made.ok) throw new Error(made.reason);
        for (let turn = 0; turn < 8; turn += 1) {
          seedTurn(made.value, { turn, user: textOf(2_000), assistant: { text: textOf(2_000), usage: { input: 10, output: 1 } } });
        }
        const state = stateWithLedger();
        state.coveredSeq = made.value.surface().at(-2)?.seq ?? -1; // 覆盖全前缀
        const outcome = escalateL2({
          state,
          session: made.value,
          nodes: made.value.surface(),
          effectiveWindow: 5_000,
          ledgerBudgetTokens: 200,
          liveBudgetFactor: factor,
          emit: () => {},
        });
        expect(outcome.ok).toBe(true);
        results.push(made.value.surface().length); // 保留区节点数
      } finally {
        await world.ctx.dispose();
      }
    }
    expect(results[1]).toBeGreaterThanOrEqual(results[0] as number); // 活口收缩 ⇒ 保留区更大
  });

  it("空账本 → 不落账；已封存会话（append 失败）→ ok:false；预算内全放得下 → 无进展不落账", async () => {
    const world = await makeWorld();
    try {
      const empty = await world.store.create({ id: sid("l2-empty") });
      if (!empty.ok) throw new Error(empty.reason);
      expect(escalateL2({ state: emptyCheckpointState(), session: empty.value, nodes: empty.value.surface(), effectiveWindow: 900, ledgerBudgetTokens: 200, emit: () => {} }).ok).toBe(false);

      const sealed = await world.store.create({ id: sid("l2-sealed") });
      if (!sealed.ok) throw new Error(sealed.reason);
      seedTurn(sealed.value, { turn: 0, user: textOf(3), assistant: { text: textOf(3) } });
      seedTurn(sealed.value, { turn: 1, user: textOf(3), assistant: { text: textOf(3) } });
      world.store.dispose(sealed.value.id); // 封存写权
      expect(escalateL2({ state: stateWithLedger(), session: sealed.value, nodes: sealed.value.surface(), effectiveWindow: 900, ledgerBudgetTokens: 200, emit: () => {} }).ok).toBe(false);

      const tiny = await world.store.create({ id: sid("l2-tiny") });
      if (!tiny.ok) throw new Error(tiny.reason);
      seedTurn(tiny.value, { turn: 0, user: "u", assistant: { text: "a" } });
      seedTurn(tiny.value, { turn: 1, user: "u", assistant: { text: "a" } });
      // 巨窗全放得下 → findCutPoint 无切口 → 无进展
      expect(escalateL2({ state: stateWithLedger(), session: tiny.value, nodes: tiny.value.surface(), effectiveWindow: 1_000_000, ledgerBudgetTokens: 200, emit: () => {} }).ok).toBe(false);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("tool_use/tool_result 配对不被 L2 切口拆散（切口恒对齐真轮起点）", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("l2-pair") });
      if (!made.ok) throw new Error(made.reason);
      const session = made.value;
      // turn-0：带工具结果；turn-1..3：文本轮
      session.append("turn/start", { turn: 0 });
      session.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text: textOf(3) }] }, { surfaceOp: "append" });
      session.append("assistant/message", { turn: 0, step: 0, content: [{ type: "tool_use", callId: "c1", name: "read", input: "{}" }], stopReason: "stop" }, { surfaceOp: "append" });
      session.append("tool/result", { turn: 0, step: 0, callId: "c1", content: textOf(5) }, { surfaceOp: "append" });
      session.append("turn/end", { turn: 0, reason: { kind: "completed" } });
      for (let turn = 1; turn < 7; turn += 1) {
        seedTurn(session, { turn, user: textOf(2_000), assistant: { text: textOf(2_000) } });
      }
      const state = stateWithLedger();
      state.coveredSeq = session.surface().at(-2)?.seq ?? -1; // 覆盖全前缀
      const result = escalateL2({ state, session, nodes: session.surface(), effectiveWindow: 900, ledgerBudgetTokens: 200, emit: () => {} });
      expect(result.ok).toBe(true);
      // 保留区内若含 tool_use 则其 tool/result 必同区（切口在真轮起点=配对安全构造）
      const messages = session.deriveMessages();
      const callIds: string[] = [];
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        for (const block of message.content as ReadonlyArray<{ type: string; callId?: string }>) {
          if (block.type === "tool_use" && block.callId !== undefined) callIds.push(block.callId);
        }
      }
      for (const callId of callIds) {
        expect(messages.some((message) => message.role === "tool" && message.callId === callId)).toBe(true);
      }
    } finally {
      await world.ctx.dispose();
    }
  });
});
