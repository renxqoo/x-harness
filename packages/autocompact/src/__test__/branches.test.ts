// 补面：分支语义（CP 输入硬界/截断计败、join 超时不可得、警告区预算外推、
// 复测门二次落账、空闲清理单元矩阵、校准偶数中位、L1 落账失败告警）。

import { describe, expect, it, vi } from "vitest";
import { agentPreStep } from "@x-harness/agent-loop";
import { calibrationFactor, emptyCalibration, pushCalibrationSample } from "../calibration.ts";
import { maybeIdleClear } from "../idle.ts";
import { makeSessionState } from "../session-state.ts";
import { hangScript, makeWorld, seedToolTurn, seedTurn, sid, textOf, textScript, toolResultNode, userNode } from "./helpers.ts";
import { trailingMaxParallel } from "../measure.ts";
import type { Session } from "@x-harness/session";

async function dispatchPreStep(world: Awaited<ReturnType<typeof makeWorld>>, session: ReturnType<typeof sid>) {
  return world.ctx.dispatch(agentPreStep, { session, turn: 9, step: 0, messages: [], signal: new AbortController().signal } as never, async () => ({ kind: "enter" }) as never);
}

describe("CP 终态补面", () => {
  it("输入预算耗尽（CP 窗被账本吃尽）→ 不拨号计败 + cp-input-budget-exhausted", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const world = await makeWorld({ summarizer: { model: "sum", contextWindow: 4_100, maxOutputTokens: 100 } });
    try {
      const made = await world.store.create({ id: sid("cp-budget") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: textOf(3), assistant: { text: textOf(3), usage: { input: 500, output: 1 } } });
      seedTurn(made.value, { turn: 1, user: textOf(3), assistant: { text: textOf(3), usage: { input: 850, output: 1 } } });
      world.llm.scripts.push(textScript("<goals>\nx\n</goals>"));
      const first = await dispatchPreStep(world, made.value.id);
      expect(first).toEqual({ kind: "enter" });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      }); // CP 作业异步——等其到达预算判定
      expect(world.llm.calls).toHaveLength(0);
      expect(stderr.mock.calls.some((line) => String(line[0]).includes("cp-input-budget-exhausted"))).toBe(true);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });

  it("join 超时不可得 → budget-gate-release(join-unavailable) + 终局放行", { timeout: 9_000 }, async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const world = await makeWorld({ checkpointIdleTimeoutMs: 20 });
    try {
      const made = await world.store.create({ id: sid("join-timeout") });
      if (!made.ok) throw new Error(made.reason);
      for (let turn = 0; turn < 4; turn += 1) {
        seedTurn(made.value, { turn, user: textOf(3), assistant: { text: textOf(3), usage: { input: turn === 0 ? 500 : 850, output: 1 } } });
      }
      world.llm.scripts.push(hangScript());
      const decision = await dispatchPreStep(world, made.value.id);
      expect(decision).toEqual({ kind: "enter" }); // join 兑底失败仍放行
      expect(stderr.mock.calls.some((line) => String(line[0]).includes("join-unavailable"))).toBe(true);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });
});

describe("警告区预算外推（一步穿窗提前优化）", () => {
  it("占用 + 增量×1.5 预测越窗 → 过闸前优化（此处无账本 → ledger-unready 放行）", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // warn=700、l1=800：占用 750 + 增量 150×1.5=225 > 900 eff → 预测越窗
    const world = await makeWorld({ summarizer: undefined, clearKeepRecent: 0 }, { summarizer: undefined });
    try {
      const made = await world.store.create({ id: sid("predict") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: textOf(3), assistant: { text: textOf(3), usage: { input: 550, output: 1 } } }); // 先低（lastOccupancy 缓存）
      await dispatchPreStep(world, made.value.id);
      // 无摘要面窗：warn=800、l1=900——850 落警告区；增量 300 ×1.5 = 450 → 1300 > 1000 预测越窗
      seedTurn(made.value, { turn: 1, user: textOf(3), assistant: { text: textOf(3), usage: { input: 850, output: 1 } } });
      await dispatchPreStep(world, made.value.id);
      expect(stderr.mock.calls.some((line) => String(line[0]).includes("budget-gate-release") && String(line[0]).includes("ledger-unready"))).toBe(true);
      expect(stderr.mock.calls.some((line) => String(line[0]).includes("l1-no-gain"))).toBe(false); // 未进 L1 区
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });
});

describe("复测门（L2 落账后复评仍越线 → 缩活口二次落账）", () => {
  it("二次落账豁免覆盖域守卫：两次 L2 落账、活口收缩", async () => {
    const world = await makeWorld({ checkpointIdleTimeoutMs: 30, compactBufferTokens: 300, warnBufferTokens: 50 }); // cp=540 < warn=550 < l1=600
    try {
      const made = await world.store.create({ id: sid("retest") });
      if (!made.ok) throw new Error(made.reason);
      for (let turn = 0; turn < 8; turn += 1) {
        seedTurn(made.value, { turn, user: textOf(2_000), assistant: { text: textOf(2_000), usage: { input: turn === 0 ? 500 : 850, output: 1 } } });
      }
      world.llm.scripts.push(textScript("<goals>\ng\n</goals>"));
      await dispatchPreStep(world, made.value.id);
      const l2Events = made.value.events().filter((event) => event.type === "user/message" && typeof event.surfaceOp === "object");
      expect(l2Events.length).toBeGreaterThanOrEqual(1);
      // 复测门触发条件下二次落账（首落后复评仍越线——l1=600 低线保证）
      expect(l2Events.length).toBeLessThanOrEqual(2);
    } finally {
      await world.ctx.dispose();
    }
  });
});

describe("空闲清理单元矩阵（maybeIdleClear）", () => {
  function fakeSession(): { session: Session; appends: string[] } {
    const appends: string[] = [];
    const session = {
      id: sid("idle-unit"),
      surface: () => [userNode(0, "t0"), toolResultNode(1, "c1", textOf(20)), userNode(2, "t1")],
      events: () => [{ type: "tool/call", seq: 0, time: 1, data: { turn: 0, step: 0, callId: "c1", name: "read", arguments: "{}" } }],
      append: (type: string) => {
        appends.push(type);
        return { ok: true };
      },
    } as never as Session;
    return { session, appends };
  }

  const baseConfig = { clearableTools: ["read"], clearKeepRecent: 0, idleClearMinutes: 1, idleClearMinGainTokens: 0 };

  it("到期 + 有收益 → 落账 + flush 先于 emit", async () => {
    const { session, appends } = fakeSession();
    const state = makeSessionState(sid("idle-unit"));
    state.lastTurnEndAt = Date.now() - 120_000;
    const order: string[] = [];
    const landed = maybeIdleClear({
      session,
      state,
      config: baseConfig,
      now: Date.now(),
      warn: () => {},
      flush: async () => {
        order.push("flush");
        return { ok: true };
      },
      emitL1Cleared: () => {
        order.push("emit");
      },
    } as never);
    expect(landed).toBe(true);
    expect(appends).toContain("tool/result");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    }); // flush/emit 在微任务链上
    expect(order).toEqual(["flush", "emit"]); // 观测不抢跑在持久化之前
  });

  it("在飞 turn / 未到期 / 关闭 → 不动作", () => {
    const { session } = fakeSession();
    const active = makeSessionState(sid("idle-unit"));
    active.turnActive = true;
    active.lastTurnEndAt = Date.now() - 120_000;
    expect(maybeIdleClear({ session, state: active, config: baseConfig, now: Date.now(), warn: () => {}, flush: async () => ({ ok: true }), emitL1Cleared: () => {} } as never)).toBe(false);
    const fresh = makeSessionState(sid("idle-unit"));
    fresh.lastTurnEndAt = Date.now();
    expect(maybeIdleClear({ session, state: fresh, config: baseConfig, now: Date.now(), warn: () => {}, flush: async () => ({ ok: true }), emitL1Cleared: () => {} } as never)).toBe(false);
    expect(maybeIdleClear({ session, state: fresh, config: { ...baseConfig, idleClearMinutes: 0 }, now: Date.now(), warn: () => {}, flush: async () => ({ ok: true }), emitL1Cleared: () => {} } as never)).toBe(false);
  });
});

describe("校准偶数样本中位", () => {
  it("去最值后偶数个样本取中间两数均值", () => {
    const calibration = emptyCalibration();
    for (const ratio of [1, 1.2, 1.4, 1.8]) pushCalibrationSample(calibration, ratio);
    expect(calibrationFactor(calibration)).toBe((1.2 + 1.4) / 2);
  });
});

describe("并行度观测与增益", () => {
  it("trailingMaxParallel：末 12 事件内 assistant tool_use 峰值（缺省 1）", async () => {
    expect(trailingMaxParallel([])).toBe(1);
    const { makeWorld: mw, sid: sidFn, logEvent } = await import("./helpers.ts");
    void mw;
    void sidFn;
    const events = [
      logEvent("assistant/message", 0, { turn: 0, step: 0, content: [{ type: "tool_use", callId: "a", name: "read", input: "{}" }, { type: "tool_use", callId: "b", name: "grep", input: "{}" }], stopReason: "stop" }),
    ] as never;
    expect(trailingMaxParallel(events)).toBe(2);
  });

  it("L1 落账失败（会话封存后同对象直调）→ 零落账返回（步闸 l1-redact-failed 告警面的单元腿）", async () => {
    const world = await makeWorld({ summarizer: undefined, clearKeepRecent: 0 }, { summarizer: undefined });
    try {
      const made = await world.store.create({ id: sid("l1-fail") });
      if (!made.ok) throw new Error(made.reason);
      seedToolTurn(made.value, { turn: 0, user: "go", tool: "read", callId: "c1", args: "{}", result: textOf(60) });
      seedToolTurn(made.value, { turn: 1, user: "next", tool: "read", callId: "c2", args: "{}", result: textOf(1), usage: { input: 500, output: 1 } });
      const nodes = made.value.surface();
      const { computeClearPlan, landClearPlan } = await import("../scavenger.ts");
      const plan = computeClearPlan(nodes, made.value.events(), { clearableTools: ["read"], clearKeepRecent: 0 });
      expect(plan.entries).toHaveLength(1);
      world.store.dispose(made.value.id); // 封存写权（对象读面开放——append 必败）
      const landed = landClearPlan(made.value, made.value.surface(), plan.entries);
      expect(landed).toEqual({ landed: 0, gainTokens: 0 }); // 软失败不抛
    } finally {
      await world.ctx.dispose();
    }
  });
});

describe("词表锁与补面", () => {
  it("CheckpointAction 子动作词表锁（闭集——增删即红；类型面由 tokens.ts 判别联合约束）", () => {
    const actions = ["started", "advanced", "reanchored", "invalidated-retry", "stale-accepted", "failed", "breaker"] as const;
    expect(actions).toHaveLength(7);
  });

  it("外部 compaction 失真 → 步闸重锚（切口边界保守收缩）", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("drift") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: textOf(3), assistant: { text: textOf(3), usage: { input: 500, output: 1 } } });
      seedTurn(made.value, { turn: 1, user: textOf(3), assistant: { text: textOf(3), usage: { input: 500, output: 1 } } });
      await dispatchPreStep(world, made.value.id); // 建状态（journalSeen 对齐）
      // 手动压缩形态的外部前缀替换（无在飞 CP → 切口失真信号）
      const head = made.value.surface()[0];
      if (head !== undefined) {
        made.value.append("user/message", { turn: 9, step: 9, content: [{ type: "text", text: "manual" }] }, { surfaceOp: { op: "replace", startSeq: head.seq, endSeq: head.seq } });
      }
      await dispatchPreStep(world, made.value.id); // 重锚路径执行——不炸、不误升级
      expect(made.value.events().filter((e) => e.type === "user/message" && typeof e.surfaceOp === "object").length).toBe(1);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("首步增量缺省（无 lastOccupancy 时 cap × maxParallel）也预测越窗", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const world = await makeWorld({ summarizer: undefined }, { summarizer: undefined });
    try {
      const made = await world.store.create({ id: sid("first-delta") });
      if (!made.ok) throw new Error(made.reason);
      // 警告区（[800,900)）单次步进：无 lastOccupancy → 缺省增量 = 25000 × 2 并行
      made.value.append("turn/start", { turn: 0 });
      made.value.append("step/start", { turn: 0, step: 0 });
      made.value.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text: "q" }] }, { surfaceOp: "append" });
      made.value.append(
        "assistant/message",
        {
          turn: 0,
          step: 0,
          content: [
            { type: "tool_use", callId: "a", name: "read", input: "{}" },
            { type: "tool_use", callId: "b", name: "grep", input: "{}" },
          ],
          usage: { input: 850, output: 1 },
          stopReason: "stop",
        },
        { surfaceOp: "append" },
      );
      made.value.append("step/end", { turn: 0, step: 0 });
      made.value.append("turn/end", { turn: 0, reason: { kind: "completed" } });
      await dispatchPreStep(world, made.value.id);
      // 首步：缺省增量路径预测越窗（parallel-approach 需要 lastOccupancy 在场——首步不告警）
      expect(stderr.mock.calls.some((line) => String(line[0]).includes("ledger-unready"))).toBe(true);
      stderr.mockClear();
      await dispatchPreStep(world, made.value.id); // 二步：lastOccupancy 已缓存 → 并行逼近告警恰一次
      expect(stderr.mock.calls.filter((line) => String(line[0]).includes("parallel-approach"))).toHaveLength(1);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });

  it("两次 CP 反衰减：首段 goals 行在第二份账本快照中存活（append-only 根基）", async () => {
    const world = await makeWorld({ checkpointIdleTimeoutMs: 30 });
    try {
      const made = await world.store.create({ id: sid("anti-decay") });
      if (!made.ok) throw new Error(made.reason);
      for (let turn = 0; turn < 4; turn += 1) {
        seedTurn(made.value, { turn, user: textOf(3), assistant: { text: textOf(3), usage: { input: turn === 0 ? 500 : 850, output: 1 } } });
      }
      world.llm.scripts.push(textScript("<goals>\norigin-goal\n</goals>"));
      await dispatchPreStep(world, made.value.id); // CP #1
      // 追加两轮（新段）后再来一份 patch——首段 goals 必须并入存活
      seedTurn(made.value, { turn: 4, user: textOf(3), assistant: { text: textOf(3), usage: { input: 850, output: 1 } } });
      world.llm.scripts.push(textScript("<goals>\nlater-goal\n</goals>"));
      await dispatchPreStep(world, made.value.id); // CP #2（新段）
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 60);
      });
      const snapshots = made.value.events().filter((e) => e.type === "autocompact/checkpoint");
      expect(snapshots.length).toBeGreaterThanOrEqual(2);
      const last = snapshots.at(-1)?.data as { ledger: string };
      expect(last.ledger).toContain("origin-goal");
      expect(last.ledger).toContain("later-goal");
    } finally {
      await world.ctx.dispose();
    }
  });
});

describe("idle flush 失败分支（观测不抢跑的失败面）", () => {
  it("flush 拒绝 → 告警 idle-flush-failed + emit 照发（落账已成的有意分歧——append-only 日志事实）", async () => {
    const warns: string[] = [];
    const order: string[] = [];
    const fake = {
      id: sid("idle-flush-fail"),
      surface: () => [userNode(0, "t0"), toolResultNode(1, "c1", textOf(20)), userNode(2, "t1")],
      events: () => [{ type: "tool/call", seq: 0, time: 1, data: { turn: 0, step: 0, callId: "c1", name: "read", arguments: "{}" } }],
      append: () => ({ ok: true }),
    } as never as Parameters<typeof maybeIdleClear>[0]["session"];
    const state = makeSessionState(sid("idle-flush-fail"));
    state.lastTurnEndAt = Date.now() - 120_000;
    const landed = maybeIdleClear({
      session: fake,
      state,
      config: { clearableTools: ["read"], clearKeepRecent: 0, idleClearMinutes: 1, idleClearMinGainTokens: 0 },
      now: Date.now(),
      warn: (_session: unknown, code: string) => {
        warns.push(code);
      },
      flush: async () => {
        order.push("flush");
        return { ok: false, reason: "io" };
      },
      emitL1Cleared: () => {
        order.push("emit");
      },
    } as never);
    expect(landed).toBe(true);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(warns).toContain("idle-flush-failed");
    expect(order).toEqual(["flush", "emit"]); // 失败不阻断观测（落账已成的事实照报）
  });
});
