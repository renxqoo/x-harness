// CP 作业全生命周期（对照参照系 checkpoint-* 语义：成功推进/失效三分支/熔断/
// 单飞行/join/恢复折叠/输入硬界/段装箱/词条落账失败计败）。


// ---------------------------------------------------------------------------
// 对照参照系（my-agent autocompact 186 条用例清单）三态映射（docs/COMPACTION.md §7）：
// 承接：语义逐条移植到本仓原语（本文件头注释逐 describe 标注对照来源）。
// 改写：hook 面 step/prepare→agentPreStep waterfall；session_meta servedWindow→
//   request/context.contextWindow；replaceHead 元数据→surfaceOp/事件 token；
//   消息计数锚→journal seq；settings→工厂选项；L0 层→不承接（agent-loop
//   maxToolResultChars 既有面——同一事实单一实现）。
// 不承接（机制不存在/死代码）：per-assembly 槽机、checkpointState defineState
//   死 token、estimateContextTokens 消息级、L0 truncateToolContent、dist 产物。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { assistantNode, FACE, fakeLlm, makeWorld, seedTurn, sid, textOf, textScript, userNode } from "./helpers.ts";
import {
  boxSegment,
  checkpointMaxChars,
  emptyCheckpointState,
  firstUncoveredIndex,
  foldCheckpointEvents,
  joinInflight,
  maybeStartCheckpoint,
} from "../checkpoint.ts";
import type { CheckpointDeps } from "../checkpoint.ts";
import { parseLedgerPatch, serializeLedger } from "../ledger.ts";
import { logEvent } from "./helpers.ts";
import type { Session } from "@x-harness/session";

const PATCH = `<goals>\ngoal-1\n</goals>\n<current>\nstep-1\n</current>`;

function depsOf(overrides: Partial<CheckpointDeps> & { session: Session; scripts: Array<AsyncGenerator<import("@x-harness/llm").LlmChunk>> }): CheckpointDeps {
  const fake = fakeLlm();
  fake.scripts.push(...overrides.scripts);
  const events: Array<{ action: string; detail?: Record<string, unknown> }> = [];
  const deps: CheckpointDeps = {
    llm: fake.runtime,
    face: FACE,
    config: { ledgerBudgetTokens: 16_000, checkpointMaxRetries: 2, checkpointIdleTimeoutMs: 0 },
    fileTools: { read: ["read"], written: ["write"], edited: [] },
    warn: () => {},
    emit: (action, detail) => {
      events.push({ action, detail });
    },
    ...overrides,
  };
  (deps as unknown as { eventsLog: unknown }).eventsLog = events;
  (deps as unknown as { fake: unknown }).fake = fake;
  return deps;
}

describe("输入硬界与段装箱", () => {
  it("checkpointMaxChars：CP 窗分母、账本字符计入、预算 < 1 → undefined", () => {
    expect(checkpointMaxChars({ ...FACE, contextWindow: 100_000, maxOutputTokens: 8_000 }, 1_000)).toBe(Math.floor((100_000 - 8_000 - 4_000 - 1_000) / 1.25));
    expect(checkpointMaxChars({ ...FACE, contextWindow: 10_000, maxOutputTokens: 8_000 }, 100)).toBeUndefined();
  });

  it("boxSegment：预算充足整段（止于在飞轮起点）、起点对齐真轮；受限只装尾部一轮；极小预算至少一轮；无完整轮 → undefined", () => {
    // [u0 a1 u2 a3 u4(在飞轮起点)]：from=0、lastTurnStart=4
    const nodes = [userNode(0, textOf(2)), assistantNode(1, textOf(2)), userNode(2, textOf(2)), assistantNode(3, textOf(2)), userNode(4, textOf(1))];
    expect(boxSegment({ nodes, from: 0, lastTurnStart: 4, tokenBudget: 100 })).toEqual({ start: 0, end: 4 });
    expect(boxSegment({ nodes, from: 0, lastTurnStart: 4, tokenBudget: 6 })).toEqual({ start: 2, end: 4 }); // 只装尾部一轮
    expect(boxSegment({ nodes, from: 0, lastTurnStart: 4, tokenBudget: 1 })).toEqual({ start: 2, end: 4 }); // 至少一轮
    expect(boxSegment({ nodes, from: 4, lastTurnStart: 4, tokenBudget: 100 })).toBeUndefined(); // from 起无完整轮
    expect(boxSegment({ nodes: [], from: 0, lastTurnStart: 0, tokenBudget: 100 })).toBeUndefined();
  });
});

describe("foldCheckpointEvents 恢复折叠", () => {
  it("快照 last-wins、垃圾跳过、负边界钳 -1", () => {
    const good = { ledger: serializeLedger(parseLedgerPatch(PATCH) ?? { goals: [], decisions: [], tasksDone: [], tasksPending: [], factsVerified: [], factsUnverified: [], current: "" }), coveredSeq: 7 };
    const events = [
      logEvent("autocompact/checkpoint", 0, { turn: 0, step: 0, ledger: good.ledger, coveredSeq: 3 }),
      logEvent("autocompact/checkpoint", 1, { turn: 0, step: 1, ledger: "garbage", coveredSeq: 5 }), // 垃圾跳过
      logEvent("autocompact/checkpoint", 2, { turn: 1, step: 1, ledger: good.ledger, coveredSeq: -5 }), // 负钳但 last-wins 会被下条覆盖
      logEvent("autocompact/checkpoint", 3, { turn: 2, step: 0, ledger: good.ledger, coveredSeq: 7 }),
    ];
    const folded = foldCheckpointEvents(events);
    expect(folded.coveredSeq).toBe(7);
    const negative = foldCheckpointEvents([logEvent("autocompact/checkpoint", 0, { turn: 0, step: 0, ledger: good.ledger, coveredSeq: -5 })]);
    expect(negative.coveredSeq).toBe(-1); // 负边界钳 -1
    expect(folded.ledger.goals).toEqual(["goal-1"]);
    expect(foldCheckpointEvents([]).coveredSeq).toBe(-1);
  });
});

describe("maybeStartCheckpoint / joinInflight", () => {
  it("lastTurnStart ≤ 覆盖边界（无新完整轮）→ 不启动；在飞作业单飞行", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("cp-gate") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: "u0", assistant: { text: "a0" } });
      const state = emptyCheckpointState();
      state.coveredSeq = made.value.surface().at(-1)?.seq ?? -1; // 全覆盖 → 无新轮
      const deps = depsOf({ session: made.value, scripts: [textScript(PATCH)] });
      expect(maybeStartCheckpoint({ state, deps, stepSignal: new AbortController().signal, lastTurnStart: 0, turn: 1, step: 0 })).toBe(false);
      state.coveredSeq = -1;
      expect(maybeStartCheckpoint({ state, deps, stepSignal: new AbortController().signal, lastTurnStart: 1, turn: 1, step: 0 })).toBe(true);
      await state.job?.done;
      expect(state.job).toBeUndefined(); // 作业落定后单飞行位清空
    } finally {
      await world.ctx.dispose();
    }
  });

  it("成功路径：patch 合并 + 覆盖边界推进 + 词条落账 + failures 清零", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("cp-ok") });
      if (!made.ok) throw new Error(made.reason);
      const session = made.value;
      seedTurn(session, { turn: 0, user: "u0", assistant: { text: "a0" } });
      seedTurn(session, { turn: 1, user: "u1", assistant: { text: "a1" } });
      const state = emptyCheckpointState();
      const deps = depsOf({ session, scripts: [textScript(PATCH)] });
      const started = maybeStartCheckpoint({ state, deps, stepSignal: new AbortController().signal, lastTurnStart: 3, turn: 9, step: 9 });
      expect(started).toBe(true);
      await state.job?.done;
      expect(state.ledger.goals).toEqual(["goal-1"]);
      expect(state.coveredSeq).toBeGreaterThan(-1);
      expect(state.consecutiveFailures).toBe(0);
      const checkpointEvent = session.events().find((event) => event.type === "autocompact/checkpoint");
      expect(checkpointEvent).toBeDefined();
      expect(firstUncoveredIndex(state, session.surface())).toBeGreaterThan(0);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("垃圾输出计败；连续 3 败熔断（breaker 事件——CP 通道停飞）", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("cp-breaker") });
      if (!made.ok) throw new Error(made.reason);
      const session = made.value;
      seedTurn(session, { turn: 0, user: "u0", assistant: { text: "a0" } });
      seedTurn(session, { turn: 1, user: "u1", assistant: { text: "a1" } });
      const state = emptyCheckpointState();
      const breakerSeen: number[] = [];
      for (let round = 0; round < 3; round += 1) {
        const deps = depsOf({ session, scripts: [textScript("garbage output")], emit: (action, detail) => {
          if (action === "breaker") breakerSeen.push((detail as { failures: number } | undefined)?.failures ?? -1);
        } });
        maybeStartCheckpoint({ state, deps, stepSignal: new AbortController().signal, lastTurnStart: 3, turn: 1, step: 0 });
        await state.job?.done;
        if (round < 2) expect(state.broken).toBe(false);
      }
      expect(state.broken).toBe(true);
      expect(breakerSeen).toEqual([3]);
      expect(maybeStartCheckpoint({ state, deps: depsOf({ session, scripts: [] }), stepSignal: new AbortController().signal, lastTurnStart: 3, turn: 2, step: 0 })).toBe(false);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("段被吞（外部 compaction 落账吞掉未收编段）→ 重锚丢弃、非失败不计数", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("cp-swallow") });
      if (!made.ok) throw new Error(made.reason);
      const session = made.value;
      seedTurn(session, { turn: 0, user: "u0", assistant: { text: "a0" } });
      seedTurn(session, { turn: 1, user: "u1", assistant: { text: "a1" } });
      seedTurn(session, { turn: 2, user: "u2", assistant: { text: "a2" } });
      const state = emptyCheckpointState();
      // 覆盖边界落在 turn-1 之前：段 = [u1, a1]（含真轮起点），from=2
      state.coveredSeq = session.surface()[1]?.seq ?? -1;
      const slow = (async function* (): AsyncGenerator<import("@x-harness/llm").LlmChunk> {
        yield { type: "text-delta", text: PATCH };
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
        yield { type: "finish", finish: { kind: "stop" } };
      })();
      const deps = depsOf({ session, scripts: [slow] });
      maybeStartCheckpoint({ state, deps, stepSignal: new AbortController().signal, lastTurnStart: 4, turn: 1, step: 0 });
      // 作业在飞时外部 compaction 吞掉全部未收编段（前缀替换至仅剩 1 节点 ≤ from=2）
      const surface = session.surface();
      const head = surface[0];
      const tail = surface[surface.length - 1];
      if (head !== undefined && tail !== undefined) {
        session.append("user/message", { turn: 9, step: 9, content: [{ type: "text", text: "external-summary" }] }, { surfaceOp: { op: "replace", startSeq: head.seq, endSeq: tail.seq } });
      }
      await state.job?.done;
      expect(state.consecutiveFailures).toBe(0); // 非失败
      expect(state.ledger.goals).toEqual([]); // patch 丢弃
    } finally {
      await world.ctx.dispose();
    }
  });

  it("失效重试路径：重拨后接受；join 无作业就绪态；词条落账失败计败", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("cp-retry") });
      if (!made.ok) throw new Error(made.reason);
      const session = made.value;
      seedTurn(session, { turn: 0, user: "u0", assistant: { text: "a0" } });
      seedTurn(session, { turn: 1, user: "u1", assistant: { text: "a1" } });
      seedTurn(session, { turn: 2, user: "u2", assistant: { text: "a2" } });
      const state = emptyCheckpointState();
      // 段中途被外部落账（首节点替换，段仍在且含真轮起点）→ 失效重试 → 第二次接受
      const slow1 = (async function* (): AsyncGenerator<import("@x-harness/llm").LlmChunk> {
        yield { type: "text-delta", text: PATCH };
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
        yield { type: "finish", finish: { kind: "stop" } };
      })();
      // 失效令牌在日志中恒在（append-only）：重拨持续失效直至重试耗尽 → 陈旧接受终态
      const deps = depsOf({ session, scripts: [slow1, textScript(PATCH), textScript(PATCH)] });
      maybeStartCheckpoint({ state, deps, stepSignal: new AbortController().signal, lastTurnStart: 4, turn: 1, step: 0 });
      const mid = session.surface()[0];
      if (mid !== undefined) {
        session.append("user/message", { turn: 9, step: 9, content: [{ type: "text", text: "drift" }] }, { surfaceOp: { op: "replace", startSeq: mid.seq, endSeq: mid.seq } });
      }
      await state.job?.done;
      expect(state.ledger.goals).toEqual(["goal-1"]); // 陈旧接受（免疫终态）
      expect(state.consecutiveFailures).toBe(0); // 非失败
      const lastCheckpoint = session.events().filter((event) => event.type === "autocompact/checkpoint").at(-1);
      expect((lastCheckpoint?.data as { stale?: true } | undefined)?.stale).toBe(true); // stale 落盘
      // join 就绪态（无作业）
      expect(await joinInflight({ state, timeoutMs: 10 })).toBe(true);
    } finally {
      await world.ctx.dispose();
    }
  });
});

describe("CP 终态矩阵补面（截断/错错/预中止/词条落败）", () => {
  it("输出截断 → 计败；provider 错 → 计败", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("cp-trunc") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: "u0", assistant: { text: "a0" } });
      seedTurn(made.value, { turn: 1, user: "u1", assistant: { text: "a1" } });
      const state = emptyCheckpointState();
      const truncated = (async function* (): AsyncGenerator<import("@x-harness/llm").LlmChunk> {
        yield { type: "text-delta", text: PATCH };
        yield { type: "finish", finish: { kind: "max-tokens" } };
      })();
      const deps1 = depsOf({ session: made.value, scripts: [truncated] });
      maybeStartCheckpoint({ state, deps: deps1, stepSignal: new AbortController().signal, lastTurnStart: 3, turn: 1, step: 0 });
      await state.job?.done;
      expect(state.consecutiveFailures).toBe(1);
      const failing = (async function* (): AsyncGenerator<import("@x-harness/llm").LlmChunk> {
        yield { type: "finish", finish: { kind: "error", message: "boom", code: "http-500" } };
      })();
      const state2 = emptyCheckpointState();
      const deps2 = depsOf({ session: made.value, scripts: [failing] });
      maybeStartCheckpoint({ state: state2, deps: deps2, stepSignal: new AbortController().signal, lastTurnStart: 3, turn: 1, step: 0 });
      await state2.job?.done;
      expect(state2.consecutiveFailures).toBe(1);
      expect(state2.ledger.goals).toEqual([]);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("step 信号预中止 → 静默非失败（拨号即取消）", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("cp-preabort") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: "u0", assistant: { text: "a0" } });
      seedTurn(made.value, { turn: 1, user: "u1", assistant: { text: "a1" } });
      const state = emptyCheckpointState();
      const deps = depsOf({ session: made.value, scripts: [textScript(PATCH)] });
      const aborted = new AbortController();
      aborted.abort();
      expect(maybeStartCheckpoint({ state, deps, stepSignal: aborted.signal, lastTurnStart: 3, turn: 1, step: 0 })).toBe(true);
      await state.job?.done;
      expect(state.consecutiveFailures).toBe(0); // 取消非失败
      expect(state.ledger.goals).toEqual([]); // 未收 patch
    } finally {
      await world.ctx.dispose();
    }
  });

  it("词条落账失败（会话封存）→ catch 计败（症状：静默丢账本）", async () => {
    // 裸 session 世界（无 autocompact 监听——sessionDisposed 取消不介入，直击
    // acceptPatch 落账失败面）
    const core = await import("@x-harness/core");
    const sessionModule = await import("@x-harness/session");
    const bare = core.createContext();
    await core.loadPlugins(bare, [sessionModule.sessionPlugin]);
    try {
      const made = await bare.use(sessionModule.sessionStore).create({ id: sid("cp-append-fail") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: "u0", assistant: { text: "a0" } });
      seedTurn(made.value, { turn: 1, user: "u1", assistant: { text: "a1" } });
      const state = emptyCheckpointState();
      const deps = depsOf({ session: made.value, scripts: [textScript(PATCH)] });
      maybeStartCheckpoint({ state, deps, stepSignal: new AbortController().signal, lastTurnStart: 3, turn: 1, step: 0 });
      bare.use(sessionModule.sessionStore).dispose(made.value.id); // 封存写权：acceptPatch 落账必败
      await state.job?.done;
      expect(state.consecutiveFailures).toBe(1); // 计败（不静默丢账本）
      expect(state.ledger.goals).toEqual(["goal-1"]); // 内存态已合并；快照未落盘（恢复期 fold 回退旧账本——warn+计数可观测）
    } finally {
      await bare.dispose();
    }
  });
});
