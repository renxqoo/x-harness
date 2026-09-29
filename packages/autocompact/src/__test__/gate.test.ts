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

describe("servedWindow 收缩与生命周期", () => {
  it("假窗口收缩 → refit 降级纯本地通道（禁 L2，release degraded）", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const world = await makeWorld();
    try {
      const session = await seeded(world, "degraded", 850);
      session.append("request/context", { provider: "p", model: "m", contextWindow: 120 });
      await dispatchPreStep(world, { session: session.id });
      const codes = stderr.mock.calls.map((line) => String(line[0]));
      expect(codes.some((line) => line.includes("lines-degraded"))).toBe(true);
      expect(codes.some((line) => line.includes("budget-gate-release") && line.includes("degraded"))).toBe(true);
      expect(session.events().some((event) => event.type === "user/message" && typeof event.surfaceOp === "object")).toBe(false);
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
  it("三档表与档位解析：1M→30/55/78、512k→35/55/75、256k(≤300k 档)→40/50/72；段 10/10/12%", () => {
    const [first, second, third] = TIERS;
    expect(first).toMatchObject({ checkpointPct: 40, l1Pct: 50, l2Pct: 72, segmentPct: 12 });
    expect(second).toMatchObject({ checkpointPct: 35, l1Pct: 55, l2Pct: 75, segmentPct: 10 });
    expect(third).toMatchObject({ checkpointPct: 30, l1Pct: 55, l2Pct: 78, segmentPct: 10 });
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

  it("缺省档位真行为（H-3 区分度）：档位 l1=55% < 兼容缺省 70%——lineTiersOf 直锁 + 装配不撞线", () => {
    const tierDefaults = lineTiersOf({ contextWindow: 1_000_000 } as never);
    expect(tierDefaults).toEqual({ checkpointPct: 30, l1Pct: 55, l2Pct: 78 });
    const mixed = lineTiersOf({ contextWindow: 1_000_000, checkpointPct: 60 } as never);
    expect(mixed).toEqual({ checkpointPct: 60, l1Pct: 70, l2Pct: 85 });
    const eff = 1_000_000 - 200;
    expect(560_000).toBeGreaterThan(Math.floor(eff * 0.55));
    expect(560_000).toBeLessThan(Math.floor(eff * 0.7));
  });
});
