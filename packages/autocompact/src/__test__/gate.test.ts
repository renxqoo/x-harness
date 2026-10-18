import { TIERS, tierOf, lineTiersOf } from "../plugin.ts";
import { describe, expect, it, vi } from "vitest";
import { agentPreStep } from "@x-harness/agent-loop";
import { compactionLanded } from "@x-harness/compaction";
import { autocompactL1Cleared, autocompactL2Escalated } from "../tokens.ts";
import { PLACEHOLDER_PREFIX } from "../scavenger.ts";
import { abortableScript, hangScript, makeWorld, seedToolTurn, seedTurn, sid, textOf, textScript } from "./helpers.ts";
import { serializeLedger } from "../ledger.ts";
import { parseLedgerPatch } from "../ledger.ts";

async function dispatchPreStep(world: Awaited<ReturnType<typeof makeWorld>>, fields: { readonly session: ReturnType<typeof sid>; readonly turn?: number; readonly step?: number }) {
  return world.ctx.dispatch(
    agentPreStep,
    { session: fields.session, turn: fields.turn ?? 9, step: fields.step ?? 0, messages: [], signal: new AbortController().signal } as never,
    async () => ({ kind: "enter" }) as never,
  );
}

const PATCH = "<goals>\ngoal-1\n</goals>\n<current>\nstep\n</current>";

async function seeded(world: Awaited<ReturnType<typeof makeWorld>>, id: string, anchorInput: number) {
  const made = await world.store.create({ id: sid(id) });
  if (!made.ok) throw new Error(made.reason);
  seedTurn(made.value, { turn: 0, user: textOf(3), assistant: { text: textOf(3), usage: { input: anchorInput, output: 1 } } });
  seedTurn(made.value, { turn: 1, user: textOf(3), assistant: { text: textOf(3), usage: { input: anchorInput, output: 1 } } });
  return made.value;
}

describe("分区放行（eff=900：cp=540 / warn=701 / l1=l2=801——单线基准形态）", () => {
  it("安全区（< 警告线）→ 原样放行、零拨号零落账", async () => {
    const world = await makeWorld();
    try {
      const session = await seeded(world, "safe", 500);
      await dispatchPreStep(world, { session: session.id });
      expect(world.llm.calls).toHaveLength(0);
      expect(session.events().some((event) => typeof event.surfaceOp === "object")).toBe(false);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("越 L1 线 + L1 预门槛成立 → redaction 落账回线下放行（零 LLM 调用——纯本地通道）", async () => {
    const world = await makeWorld({ summarizer: undefined, clearKeepRecent: 0, l1Pct: 95, l2Pct: 95 }, { summarizer: undefined });
    const cleared: string[] = [];
    world.ctx.on(autocompactL1Cleared, (payload) => cleared.push(payload.trigger));
    try {
      const made = await world.store.create({ id: sid("l1") });
      if (!made.ok) throw new Error(made.reason);
      seedToolTurn(made.value, { turn: 0, user: "go", tool: "read", callId: "c1", args: JSON.stringify({ path: "/a.ts" }), result: textOf(60) });
      seedToolTurn(made.value, { turn: 1, user: "next", tool: "read", callId: "c2", args: "{}", result: textOf(1), usage: { input: 950, output: 1 } });
      await dispatchPreStep(world, { session: made.value.id });
      expect(world.llm.calls).toHaveLength(0);
      expect(cleared).toEqual(["watermark"]);
      const clearedNode = made.value.surface().find((node) => node.event.type === "tool/result" && (node.event.data as { content: string }).content.startsWith(PLACEHOLDER_PREFIX));
      expect(clearedNode).toBeDefined();
      expect(made.value.events().some((event) => event.type === "user/message" && typeof event.surfaceOp === "object")).toBe(false);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("分层行为（缺省 70/85 线序）：L1 落账后占用落在 (l1,l2) 区间 → 不动账本（免费层不消耗付费层）", async () => {
    const world = await makeWorld({ summarizer: undefined, clearKeepRecent: 0, l1Pct: 70, l2Pct: 85 }, { summarizer: undefined });
    try {
      const made = await world.store.create({ id: sid("layered") });
      if (!made.ok) throw new Error(made.reason);
      seedToolTurn(made.value, { turn: 0, user: "go", tool: "read", callId: "cl", args: "{}", result: textOf(150) });
      seedToolTurn(made.value, { turn: 1, user: "next", tool: "read", callId: "c2", args: "{}", result: textOf(1), usage: { input: 800, output: 1 } });
      await dispatchPreStep(world, { session: made.value.id });
      const cleared = made.value.surface().some((node) => node.event.type === "tool/result" && (node.event.data as { content: string }).content.startsWith(PLACEHOLDER_PREFIX));
      expect(cleared).toBe(true);
      expect(made.value.events().some((event) => event.type === "user/message" && typeof event.surfaceOp === "object")).toBe(false);
      expect(world.llm.calls).toHaveLength(0);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("清无可清（收益 <1000）→ l1-no-gain 退避 + 账本未就绪放行；终局恒 enter", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const world = await makeWorld({ summarizer: undefined, clearKeepRecent: 0 }, { summarizer: undefined });
    try {
      const session = await seeded(world, "nogain", 950);
      const decision = await dispatchPreStep(world, { session: session.id });
      expect(decision).toEqual({ kind: "enter" });
      expect(world.llm.calls).toHaveLength(0);
      const codes = stderr.mock.calls.map((line) => String(line[0]));
      expect(codes.some((line) => line.includes("l1-no-gain"))).toBe(true);
      expect(codes.some((line) => line.includes("budget-gate-release") && line.includes("ledger-unready"))).toBe(true);
      stderr.mockClear();
      await dispatchPreStep(world, { session: session.id });
      expect(stderr.mock.calls.filter((line) => String(line[0]).includes("l1-no-gain"))).toHaveLength(0);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });

  it("死区联动（症状:mrod40 卡 707k 在 l1/l2 间空转）:l1-backoff 且 occupancy 超 l1 线 15 点 → 未到 l2 线也 escalateOrJoin", async () => {
    const world = await makeWorld({ l1Pct: 50, l2Pct: 95, checkpointPct: 20, summarizer: undefined, clearKeepRecent: 0 }, { summarizer: undefined });
    try {
      const made = await world.store.create({ id: sid("deadzone") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: textOf(3), assistant: { text: textOf(3), usage: { input: 900, output: 1 } } });
      seedTurn(made.value, { turn: 1, user: textOf(3), assistant: { text: textOf(3), usage: { input: 660, output: 1 } } });
      await dispatchPreStep(world, { session: made.value.id });
      const warn = made.value.events().find((event) => event.type === "compaction/diagnostic" && JSON.stringify(event.data).includes("l1-no-gain"));
      expect(warn).toBeDefined();
    } finally {
      await world.ctx.dispose();
    }
  });

  it("超窗检测（症状:128k 假窗口会话 input 达窗口 223% 静默跑完）:usage 锚超声明窗口 → window-overfill 告警且按实测收缩水位", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const world = await makeWorld({ contextWindow: 1_000, l1Pct: 50, l2Pct: 95, checkpointPct: 20, summarizer: undefined, clearKeepRecent: 0 }, { summarizer: undefined });
    try {
      const made = await world.store.create({ id: sid("overfill") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: textOf(3), assistant: { text: textOf(3), usage: { input: 2_000, output: 1 } } });
      seedTurn(made.value, { turn: 1, user: textOf(3), assistant: { text: textOf(3), usage: { input: 2_000, output: 1 } } });
      await dispatchPreStep(world, { session: made.value.id });
      const overfill = stderr.mock.calls.find((line) => String(line[0]).includes("window-overfill"));
      expect(overfill).toBeDefined();
      expect(String(overfill?.[0])).toContain('"declared":1000');
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });

  it("L2 单步预测（症状:cmxidv 越线 +186k 才压缩）:occupancy 未到 l2 但单步增量预测越线 → 提前 escalateOrJoin", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const world = await makeWorld({ l1Pct: 50, l2Pct: 95, checkpointPct: 20, summarizer: undefined, clearKeepRecent: 0 }, { summarizer: undefined });
    try {
      const made = await world.store.create({ id: sid("predict") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: textOf(3), assistant: { text: textOf(3), usage: { input: 600, output: 1 } } });
      seedTurn(made.value, { turn: 1, user: textOf(3), assistant: { text: textOf(3), usage: { input: 660, output: 1 } } });
      await dispatchPreStep(world, { session: made.value.id });
      const released = stderr.mock.calls.some((line) => String(line[0]).includes("budget-gate-release"));
      expect(released).toBe(true);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });
});

describe("CP + L2 旅程（账本就绪 → 越线 L2 零新 CP）", () => {
  it("CP 起飞（cp 水位以上 + armed + 段门槛）→ patch 落账 → 越线 join 后 L2 落账", async () => {
    const world = await makeWorld({ checkpointIdleTimeoutMs: 30 });
    const escalated: number[] = [];
    world.ctx.on(autocompactL2Escalated, (payload) => escalated.push(payload.keptNodes));
    try {
      const made = await world.store.create({ id: sid("cp-l2") });
      if (!made.ok) throw new Error(made.reason);
      for (let turn = 0; turn < 4; turn += 1) {
        seedTurn(made.value, { turn, user: textOf(300), assistant: { text: textOf(300), usage: { input: turn < 2 ? 500 : 850, output: 1 } } });
      }
      world.llm.scripts.push(textScript(PATCH), textScript(PATCH));
      await dispatchPreStep(world, { session: made.value.id });
      expect(world.llm.calls.length).toBeGreaterThanOrEqual(1);
      expect(escalated).toHaveLength(1);
      const head = made.value.deriveMessages()[0] as { content: ReadonlyArray<{ text: string }> };
      expect(head.content[0]?.text).toContain("<goals>");
      expect(made.value.events().some((event) => event.type === "autocompact/checkpoint")).toBe(true);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("恢复旅程：checkpoint 词条折叠重建账本 → 越线 L2 零新拨号", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("recover") });
      if (!made.ok) throw new Error(made.reason);
      for (let turn = 0; turn < 4; turn += 1) {
        seedTurn(made.value, { turn, user: textOf(300), assistant: { text: textOf(300), usage: { input: 850, output: 1 } } });
      }
      const nodes = made.value.surface();
      made.value.append("autocompact/checkpoint", {
        turn: 3,
        step: 0,
        ledger: serializeLedger(parseLedgerPatch(PATCH) ?? { goals: [], decisions: [], tasksDone: [], tasksPending: [], factsVerified: [], factsUnverified: [], current: "" }),
        coveredSeq: nodes[nodes.length - 2]?.seq ?? -1,
      });
      await dispatchPreStep(world, { session: made.value.id });
      expect(world.llm.calls).toHaveLength(0);
      const head = made.value.deriveMessages()[0] as { content: ReadonlyArray<{ text: string }> };
      expect(head.content[0]?.text).toContain("goal-1");
    } finally {
      await world.ctx.dispose();
    }
  });
});

describe("水位权分居（autocompact 不接管 compaction 水位——强制压缩带归 compaction）", () => {
  it("自面就绪且占用超 compaction 水位（980 > 900）→ compaction 仍自主压缩（compactionLanded 落账）", async () => {
    const world = await makeWorld();
    const landed: string[] = [];
    world.ctx.on(compactionLanded, (payload) => landed.push(payload.trigger));
    try {
      const session = await seeded(world, "pct-forced", 980);
      world.llm.scripts.push(textScript("## Goal\nforced\n\n## Progress\n### In Progress\n- [ ] t"));
      await dispatchPreStep(world, { session: session.id });
      expect(landed).toEqual(["auto"]);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("自面缺席（摘要面未配置）→ 零接管副作用、零拨号（纯本地通道照常）", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const world = await makeWorld({ summarizer: undefined }, { summarizer: undefined });
    try {
      const session = await seeded(world, "skip", 500);
      await dispatchPreStep(world, { session: session.id });
      await dispatchPreStep(world, { session: session.id });
      expect(world.llm.calls).toHaveLength(0);
      expect(stderr.mock.calls.filter((line) => String(line[0]).includes("takeover-skipped"))).toHaveLength(0);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });
});

describe("exhausted 暂停 gate（对抗审查 #4 回归）", () => {
  it("compaction/exhausted 落账后 gate 停跑、replace 落地后恢复（三振后不自动降级 L2）", { timeout: 15_000 }, async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("paused") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: textOf(3), assistant: { text: textOf(3), usage: { input: 850, output: 1 } } });
      made.value.append("compaction/exhausted", { turn: 9, step: 0, attempts: 3 });
      const cleared: string[] = [];
      world.ctx.on(autocompactL1Cleared, (payload) => cleared.push(payload.trigger));
      await dispatchPreStep(world, { session: made.value.id });
      expect(cleared).toHaveLength(0);
      // 判别场景（审查 A4：上一断言在旧实现同样通过——事件投递时序使然）：
      // journal 预置 exhausted + 存在可清工具结果 → 新建 state 首步必须零落账。
      // 旧实现（内存 Set + 恢复逻辑缺失）此场景会错误清账（L1-CLEARED 落 placeholder）。
      const made2 = await world.store.create({ id: sid("paused-recover") });
      if (!made2.ok) throw new Error(made2.reason);
      seedToolTurn(made2.value, { turn: 0, user: "go", tool: "read", callId: "cr", args: "{}", result: textOf(60) });
      seedToolTurn(made2.value, { turn: 1, user: "next", tool: "read", callId: "cr2", args: "{}", result: textOf(1), usage: { input: 950, output: 1 } });
      made2.value.append("compaction/exhausted", { turn: 9, step: 0, attempts: 3 });
      const cleared2: string[] = [];
      world.ctx.on(autocompactL1Cleared, (payload) => cleared2.push(payload.trigger));
      await dispatchPreStep(world, { session: made2.value.id });
      expect(cleared2).toHaveLength(0);
      expect(made2.value.surface().some((node) => node.event.type === "tool/result" && node.event.data.content.startsWith(PLACEHOLDER_PREFIX))).toBe(false);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });
});

describe("degraded 保留 L1（修复回归：refit 降级不再禁用本地免费清除）", () => {
  it("servedWindow 深收缩 + 可清工具结果 → degraded 分支仍落 L1 redaction（旧实现直接静默）", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // 单装 autocompact（不经 compaction 插件，避免 exhausted 三振路径干扰观测）
    const { createContext, loadPlugins } = await import("@x-harness/core");
    const sessionMod = await import("@x-harness/session");
    const { createCompactionPlugin } = await import("@x-harness/compaction");
    const { createAutoCompactPlugin } = await import("../plugin.ts");
    const { llmRuntime } = await import("@x-harness/llm");
    const helpers = await import("./helpers.ts");
    const ctx = createContext();
    const fake = helpers.fakeLlm();
    // compaction 插件保留（autocompact inject 依赖），但 summarizer 未配置 → 水位路径
    // warnOnce summarizer-unconfigured 后直接 return，不会三振 exhausted，不干扰 gate 观测
    await loadPlugins(ctx, [
      sessionMod.sessionPlugin,
      // compaction 声明窗给大值：其 92% 水位线不触发（本用例只验 autocompact 的 degraded 分支）
      createCompactionPlugin({ contextWindow: 1_000_000, reserveTokens: 50, keepRecentTokens: 1, keepMinTurns: 5, triggerPct: 92, summarizer: undefined } as never),
      // summarizer face 必须给：computeLines 的 reserve 依赖 maxOutputTokens，
      // face 缺失时 reserve=0 → effectiveWindow 不收缩 → refit 不触发，测不到 degraded 分支
      createAutoCompactPlugin({ contextWindow: 1_000, checkpointPct: 60, l1Pct: 89, l2Pct: 89, warnBufferTokens: 100, checkpointMinSegmentTokens: 1, ledgerBudgetTokens: 200, summarizer: { model: "sum", contextWindow: 100_000, maxOutputTokens: 100 }, clearKeepRecent: 0 } as never),
    ]);
    ctx.provide(llmRuntime, fake.runtime);
    try {
      const store = ctx.use(sessionMod.sessionStore);
      const made = await store.create({ id: helpers.sid("dg-l1") });
      if (!made.ok) throw new Error(made.reason);
      // 两轮带 read 工具结果的 turn + 窗口收缩到 120（occupancy 850 >> 线 → refit degraded）
      helpers.seedToolTurn(made.value, { turn: 0, user: "go", tool: "read", callId: "c1", args: JSON.stringify({ path: "/a.ts" }), result: helpers.textOf(60) });
      helpers.seedToolTurn(made.value, { turn: 1, user: "next", tool: "read", callId: "c2", args: "{}", result: helpers.textOf(1), usage: { input: 850, output: 1 } });
      made.value.append("request/context", { provider: "p", model: "m", contextWindow: 120 });
      const cleared: string[] = [];
      ctx.on(autocompactL1Cleared, (payload) => cleared.push(payload.trigger));
      await ctx.dispatch(agentPreStep, { session: made.value.id, turn: 9, step: 0, messages: [], signal: new AbortController().signal } as never, async () => ({ kind: "enter" }) as never);
      expect(cleared.length).toBeGreaterThan(0);
      expect(made.value.surface().some((node) => node.event.type === "tool/result" && node.event.data.content.startsWith(PLACEHOLDER_PREFIX))).toBe(true);
    } finally {
      stderr.mockRestore();
      await ctx.dispose();
    }
  });
});

describe("跨 turn 首步观测增量（审查 A1 判别回归：转存次序 bug 曾使 turnStartOccupancy 恒 undefined、首步外推退 cap 常量恒越窗）", () => {
  it("turn0 末占用 60k → turn1 首步 70k（小增量）→ 不触发 escalate（cap 路径会算 70k+84k>128k 误升级）", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const world = await makeWorld({ summarizer: undefined, clearKeepRecent: 0, contextWindow: 128_000, l1Pct: 60, l2Pct: 75, warnBufferTokens: 10_000 }, { summarizer: undefined, contextWindow: 128_000 });
    try {
      const made = await world.store.create({ id: sid("turnstep") });
      if (!made.ok) throw new Error(made.reason);
      // turn0：anchor 60k，gate 跑完写 lastOccupancy
      seedTurn(made.value, { turn: 0, user: textOf(3), assistant: { text: textOf(3), usage: { input: 60_000, output: 1 } } });
      await dispatchPreStep(world, { session: made.value.id, turn: 0 });
      // 真实 turn 边界：turn/start 落 journal 并经 microtask 投递
      made.value.append("turn/start", { turn: 1 });
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 10);
      });
      // turn1 首步：anchor 70k ∈ [warnLine, l1Line) 警告区，跨 turn 观测增量 10k
      // （种子不含 turn/start——手动边界事件已发，重复事件会二次触发转存路径）
      made.value.append("user/message", { turn: 1, step: 0, content: [{ type: "text", text: textOf(3) }] }, { surfaceOp: "append" });
      made.value.append("assistant/message", { turn: 1, step: 0, content: [{ type: "text", text: textOf(3) }], usage: { input: 70_000, output: 1 }, stopReason: "stop" }, { surfaceOp: "append" });
      await dispatchPreStep(world, { session: made.value.id, turn: 1 });
      const escalated = stderr.mock.calls.filter((line) => String(line[0]).includes("budget-gate-release")).length;
      expect(escalated).toBe(0);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });
});

describe("servedWindow 收缩与生命周期", () => {
  it("假窗口收缩 → refit 降级释放（degraded 保留 L1 通道 + release 语义）；exhausted 三振后 gate 停跑（gatePaused 恢复回归）", { timeout: 15_000 }, async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const world = await makeWorld();
    try {
      const session = await seeded(world, "degraded", 850);
      session.append("request/context", { provider: "p", model: "m", contextWindow: 120 });
      const decision = await dispatchPreStep(world, { session: session.id });
      const codes = stderr.mock.calls.map((line) => String(line[0]));
      expect(codes.filter((line) => line.includes("trigger-noop"))).toHaveLength(3);
      expect(session.events().some((event) => event.type === "compaction/exhausted")).toBe(true);
      expect(decision).toEqual({ kind: "reject", reason: "compact-exhausted" });
      expect(session.events().some((event) => event.type === "user/message" && typeof event.surfaceOp === "object")).toBe(false);
      // gatePaused 恢复（修复回归）：exhausted 落账后，state 首建/后续 step 均不再重跑 gate——
      // degraded 诊断不再重复出现（旧行为依赖「事件投递竞态漏置 gatePaused」，已被恢复逻辑取代）
      const degradedSeen = () => stderr.mock.calls.filter((line) => String(line[0]).includes("lines-degraded")).length;
      const afterFirst = degradedSeen();
      await dispatchPreStep(world, { session: session.id });
      expect(degradedSeen()).toBe(afterFirst);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });

  it("sessionDisposed：在飞 CP 取消（信号感知脚本快速落定、无失败观测、零词条）", { timeout: 9_000 }, async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const world = await makeWorld({ checkpointIdleTimeoutMs: 10_000 });
    try {
      const made = await world.store.create({ id: sid("dispose") });
      if (!made.ok) throw new Error(made.reason);
      for (let turn = 0; turn < 3; turn += 1) {
        seedTurn(made.value, { turn, user: textOf(3), assistant: { text: textOf(3), usage: { input: turn === 0 ? 500 : 550, output: 1 } } });
      }
      world.llm.scripts.push(abortableScript("patch-text"));
      await dispatchPreStep(world, { session: made.value.id });
      world.store.dispose(made.value.id);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(made.value.events().some((event) => event.type === "autocompact/checkpoint")).toBe(false);
      expect(stderr.mock.calls.some((line) => String(line[0]).includes("checkpoint-failed"))).toBe(false);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });

  it("插件 dispose：在飞作业取消 + 有界 join（不吊死拆卸）", { timeout: 9_000 }, async () => {
    const world = await makeWorld({ checkpointIdleTimeoutMs: 60_000 });
    const made = await world.store.create({ id: sid("unwind") });
    if (!made.ok) throw new Error(made.reason);
    for (let turn = 0; turn < 3; turn += 1) {
      seedTurn(made.value, { turn, user: textOf(3), assistant: { text: textOf(3), usage: { input: turn === 0 ? 500 : 550, output: 1 } } });
    }
    world.llm.scripts.push(hangScript());
    await dispatchPreStep(world, { session: made.value.id });
    const started = Date.now();
    await world.ctx.dispose();
    expect(Date.now() - started).toBeLessThan(5_500);
  });

  it("多会话状态隔离：A 越 L1 线落 L1、B 安全区零落账互不串", async () => {
    const world = await makeWorld({ summarizer: undefined, clearKeepRecent: 0, l1Pct: 95, l2Pct: 95 }, { summarizer: undefined });
    try {
      const madeA = await world.store.create({ id: sid("iso-a") });
      const madeB = await world.store.create({ id: sid("iso-b") });
      if (!madeA.ok || !madeB.ok) throw new Error("create failed");
      seedToolTurn(madeA.value, { turn: 0, user: "go", tool: "read", callId: "ca", args: "{}", result: textOf(60) });
      seedToolTurn(madeA.value, { turn: 1, user: "next", tool: "read", callId: "cb", args: "{}", result: textOf(1), usage: { input: 950, output: 1 } });
      seedToolTurn(madeB.value, { turn: 0, user: "go", tool: "read", callId: "cc", args: "{}", result: textOf(60) });
      seedToolTurn(madeB.value, { turn: 1, user: "next", tool: "read", callId: "cd", args: "{}", result: textOf(1), usage: { input: 500, output: 1 } });
      await dispatchPreStep(world, { session: madeA.value.id });
      await dispatchPreStep(world, { session: madeB.value.id });
      const clearedOf = (session: { surface: () => ReadonlyArray<{ event: { type: string; data: { content: string } } }> }) =>
        session.surface().some((node) => node.event.type === "tool/result" && node.event.data.content.startsWith(PLACEHOLDER_PREFIX));
      expect(clearedOf(madeA.value as never)).toBe(true);
      expect(clearedOf(madeB.value as never)).toBe(false);
    } finally {
      await world.ctx.dispose();
    }
  });
});

describe("空闲清理（时间分支）", () => {
  it("到期 + 有收益 → 定时器落账 redaction（idleClearMinutes 极小值端到端）", async () => {
    const world = await makeWorld({ idleClearMinutes: 0.001, clearKeepRecent: 0 });
    const cleared: string[] = [];
    world.ctx.on(autocompactL1Cleared, (payload) => cleared.push(payload.trigger));
    try {
      const made = await world.store.create({ id: sid("idle") });
      if (!made.ok) throw new Error(made.reason);
      seedToolTurn(made.value, { turn: 0, user: "go", tool: "read", callId: "c1", args: JSON.stringify({ path: "/i.ts" }), result: textOf(40) });
      seedToolTurn(made.value, { turn: 1, user: "next", tool: "read", callId: "c2", args: "{}", result: textOf(1), usage: { input: 500, output: 1 } });
      await dispatchPreStep(world, { session: made.value.id });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 400);
      });
      expect(cleared).toEqual(["idle"]);
      const clearedNode = made.value.surface().find((node) => node.event.type === "tool/result" && (node.event.data as { content: string }).content.startsWith(PLACEHOLDER_PREFIX));
      expect(clearedNode).toBeDefined();
    } finally {
      await world.ctx.dispose();
    }
  });

  it("关闭条件：在飞 turn 不清；收益不足门槛不清（idleClearMinGainTokens）", async () => {
    const world = await makeWorld({ idleClearMinutes: 0.001, idleClearMinGainTokens: 10_000 });
    try {
      const made = await world.store.create({ id: sid("idle-off") });
      if (!made.ok) throw new Error(made.reason);
      seedToolTurn(made.value, { turn: 0, user: "go", tool: "read", callId: "c1", args: "{}", result: textOf(40) });
      seedToolTurn(made.value, { turn: 1, user: "next", tool: "read", callId: "c2", args: "{}", result: textOf(1), usage: { input: 500, output: 1 } });
      await dispatchPreStep(world, { session: made.value.id });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 400);
      });
      expect(made.value.surface().some((node) => node.event.type === "tool/result" && (node.event.data as { content: string }).content.startsWith(PLACEHOLDER_PREFIX))).toBe(false);
    } finally {
      await world.ctx.dispose();
    }
  });
});



describe("阈值窗口分档（autocompact）", () => {
  it("三档表与档位解析：1M→43/50/68、512k→45/55/70、256k(≤300k 档)→50/60/75（cp 由 l2−25 派生）；段 10/10/12%", () => {
    const [first, second, third] = TIERS;
    expect(first).toMatchObject({ l1Pct: 60, l2Pct: 75, segmentPct: 12 });
    expect(second).toMatchObject({ l1Pct: 55, l2Pct: 70, segmentPct: 10 });
    expect(third).toMatchObject({ l1Pct: 50, l2Pct: 68, segmentPct: 10 });
    expect(tierOf(300_000)).toBe(first);
    expect(tierOf(300_001)).toBe(second);
    expect(tierOf(700_000)).toBe(second);
    expect(tierOf(700_001)).toBe(third);
    expect(tierOf(Number.NaN)).toBe(third);
  });

  it("层序不变量全档成立（cp ≤ l1 ≤ l2 < eff·l2——assertLinesDomain 不抛）", () => {
    for (const window of [128_000, 200_000, 256_000, 300_000, 400_000, 512_000, 700_001, 1_000_000]) {
      expect(() => makeWorld({ contextWindow: window, checkpointIdleTimeoutMs: 30 })).not.toThrow();
    }
  });

  it("成组语义（M-1）：三 pct 任一显式 → 缺席参数回落兼容值（60/70/85）非档位", async () => {
    const world = await makeWorld({ contextWindow: 1_000_000, checkpointPct: 60, checkpointIdleTimeoutMs: 30 });
    try {
      const made = await world.store.create({ id: sid("group") });
      if (!made.ok) throw new Error(made.reason);
      expect(made.ok).toBe(true);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("缺省档位真行为（H-3 区分度）：1M 档 43/50/68、cp=l2−25 派生——lineTiersOf 直锁", () => {
    const tierDefaults = lineTiersOf({ contextWindow: 1_000_000 } as never);
    expect(tierDefaults).toEqual({ checkpointPct: 43, l1Pct: 50, l2Pct: 68 });
    const mixed = lineTiersOf({ contextWindow: 1_000_000, checkpointPct: 60 } as never);
    expect(mixed).toEqual({ checkpointPct: 60, l1Pct: 70, l2Pct: 85 });
    const small = lineTiersOf({ contextWindow: 256_000 } as never);
    expect(small).toEqual({ checkpointPct: 50, l1Pct: 60, l2Pct: 75 });
  });
});
