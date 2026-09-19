// 装配层：步闸分区/接管/降级/恢复/生命周期（对照参照系 gate-*/plugin-runtime/
// resilience/journeys 语义；hook 面改写为 agentPreStep waterfall dispatch）。


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

/** 占用锚在给定值的会话（l1 线 800 / warn 线 700 / cp 水位 540） */
async function seeded(world: Awaited<ReturnType<typeof makeWorld>>, id: string, anchorInput: number) {
  const made = await world.store.create({ id: sid(id) });
  if (!made.ok) throw new Error(made.reason);
  seedTurn(made.value, { turn: 0, user: textOf(3), assistant: { text: textOf(3), usage: { input: anchorInput, output: 1 } } });
  seedTurn(made.value, { turn: 1, user: textOf(3), assistant: { text: textOf(3), usage: { input: anchorInput, output: 1 } } });
  return made.value;
}

describe("分区放行（eff=900：cp=540 / warn=700 / l1=800）", () => {
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
    const world = await makeWorld({ summarizer: undefined, clearKeepRecent: 0 }, { summarizer: undefined }); // 无摘要面：eff=1000、l1=900、cp=600
    const cleared: string[] = [];
    world.ctx.on(autocompactL1Cleared, (payload) => cleared.push(payload.trigger));
    try {
      const made = await world.store.create({ id: sid("l1") });
      if (!made.ok) throw new Error(made.reason);
      // 旧工具结果 ~60 token：占用 950 − 60 = 890 < 900
      seedToolTurn(made.value, { turn: 0, user: "go", tool: "read", callId: "c1", args: JSON.stringify({ path: "/a.ts" }), result: textOf(60) });
      seedToolTurn(made.value, { turn: 1, user: "next", tool: "read", callId: "c2", args: "{}", result: textOf(1), usage: { input: 950, output: 1 } });
      await dispatchPreStep(world, { session: made.value.id });
      expect(world.llm.calls).toHaveLength(0); // 零 LLM
      expect(cleared).toEqual(["watermark"]);
      const clearedNode = made.value.surface().find((node) => node.event.type === "tool/result" && (node.event.data as { content: string }).content.startsWith(PLACEHOLDER_PREFIX));
      expect(clearedNode).toBeDefined();
      expect(made.value.events().some((event) => event.type === "user/message" && typeof event.surfaceOp === "object")).toBe(false); // 无 L2/压缩落账
    } finally {
      await world.ctx.dispose();
    }
  });

  it("清无可清（收益 <1000）→ l1-no-gain 退避 + 账本未就绪放行；终局恒 enter", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const world = await makeWorld({ summarizer: undefined, clearKeepRecent: 0 }, { summarizer: undefined }); // 纯本地通道
    try {
      const session = await seeded(world, "nogain", 950); // 无可清工具结果
      const decision = await dispatchPreStep(world, { session: session.id });
      expect(decision).toEqual({ kind: "enter" }); // 终局恒放行
      expect(world.llm.calls).toHaveLength(0);
      const codes = stderr.mock.calls.map((line) => String(line[0]));
      expect(codes.some((line) => line.includes("l1-no-gain"))).toBe(true);
      expect(codes.some((line) => line.includes("budget-gate-release") && line.includes("ledger-unready"))).toBe(true);
      stderr.mockClear();
      await dispatchPreStep(world, { session: session.id });
      expect(stderr.mock.calls.filter((line) => String(line[0]).includes("l1-no-gain"))).toHaveLength(0); // 本 turn 退避
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
      // 第一次步闸：占用 850 ≥ cp 540 → CP 起飞；≥ l1 800 → L1 无可清 → join 在飞 → 就绪 → L2
      await dispatchPreStep(world, { session: made.value.id });
      expect(world.llm.calls.length).toBeGreaterThanOrEqual(1); // CP 拨号
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
      // 预置持久化账本快照（覆盖全前缀）——重开会话形态
      const nodes = made.value.surface();
      made.value.append("autocompact/checkpoint", {
        turn: 3,
        step: 0,
        ledger: serializeLedger(parseLedgerPatch(PATCH) ?? { goals: [], decisions: [], tasksDone: [], tasksPending: [], factsVerified: [], factsUnverified: [], current: "" }),
        coveredSeq: nodes[nodes.length - 2]?.seq ?? -1,
      });
      await dispatchPreStep(world, { session: made.value.id });
      expect(world.llm.calls).toHaveLength(0); // 零新 CP
      const head = made.value.deriveMessages()[0] as { content: ReadonlyArray<{ text: string }> };
      expect(head.content[0]?.text).toContain("goal-1"); // L2 用恢复的账本落账
    } finally {
      await world.ctx.dispose();
    }
  });
});

describe("接管仲裁", () => {
  it("自面就绪 → 接管：水位超也不自主压缩（无 compactionLanded）；跳过后不再重试", async () => {
    const world = await makeWorld();
    const landed: string[] = [];
    world.ctx.on(compactionLanded, (payload) => landed.push(payload.trigger));
    try {
      const session = await seeded(world, "takeover", 980); // 超 compaction 阈值（1000 − 50 = 950）
      await dispatchPreStep(world, { session: session.id });
      await dispatchPreStep(world, { session: session.id });
      expect(landed).toEqual([]); // 水位权已接管——无 compaction 落账
    } finally {
      await world.ctx.dispose();
    }
  });

  it("自面缺席（摘要面未配置）→ 不接管 + takeover-skipped 恰一次", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const world = await makeWorld({ summarizer: undefined }, { summarizer: undefined });
    try {
      // 覆盖 compaction 的摘要面也置空（runner.summarizer 单一真相面）
      const session = await seeded(world, "skip", 500);
      await dispatchPreStep(world, { session: session.id });
      await dispatchPreStep(world, { session: session.id });
      expect(stderr.mock.calls.filter((line) => String(line[0]).includes("takeover-skipped"))).toHaveLength(1);
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
      session.append("request/context", { provider: "p", model: "m", contextWindow: 300 }); // servedWindow 深收缩
      await dispatchPreStep(world, { session: session.id });
      const codes = stderr.mock.calls.map((line) => String(line[0]));
      expect(codes.some((line) => line.includes("lines-degraded"))).toBe(true);
      expect(codes.some((line) => line.includes("budget-gate-release") && line.includes("degraded"))).toBe(true);
      expect(session.events().some((event) => event.type === "user/message" && typeof event.surfaceOp === "object")).toBe(false); // 禁 L2
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
      await dispatchPreStep(world, { session: made.value.id }); // CP 起飞（占用 550 在 cp 与 warn 之间——不进 L1/join）
      world.store.dispose(made.value.id); // 取消在飞作业（脚本随 signal 快速收尾——取消路径可观测）
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(made.value.events().some((event) => event.type === "autocompact/checkpoint")).toBe(false); // 无词条落账
      expect(stderr.mock.calls.some((line) => String(line[0]).includes("checkpoint-failed"))).toBe(false); // 取消非失败
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
    await dispatchPreStep(world, { session: made.value.id }); // CP 起飞（挂死流；不进 L1/join）
    const started = Date.now();
    await world.ctx.dispose(); // disposer：cancel + 5s 有界 join
    expect(Date.now() - started).toBeLessThan(5_500);
  });

  it("多会话状态隔离：A 越 L1 线落 L1、B 安全区零落账互不串", async () => {
    const world = await makeWorld({ summarizer: undefined, clearKeepRecent: 0 }, { summarizer: undefined });
    try {
      const madeA = await world.store.create({ id: sid("iso-a") });
      const madeB = await world.store.create({ id: sid("iso-b") });
      if (!madeA.ok || !madeB.ok) throw new Error("create failed");
      // A：旧大结果 + 占用 950（≥ l1 900）；B：同形但占用 500（安全区）
      seedToolTurn(madeA.value, { turn: 0, user: "go", tool: "read", callId: "ca", args: "{}", result: textOf(60) });
      seedToolTurn(madeA.value, { turn: 1, user: "next", tool: "read", callId: "cb", args: "{}", result: textOf(1), usage: { input: 950, output: 1 } });
      seedToolTurn(madeB.value, { turn: 0, user: "go", tool: "read", callId: "cc", args: "{}", result: textOf(60) });
      seedToolTurn(madeB.value, { turn: 1, user: "next", tool: "read", callId: "cd", args: "{}", result: textOf(1), usage: { input: 500, output: 1 } });
      await dispatchPreStep(world, { session: madeA.value.id });
      await dispatchPreStep(world, { session: madeB.value.id });
      const clearedOf = (session: { surface: () => ReadonlyArray<{ event: { type: string; data: { content: string } } }> }) =>
        session.surface().some((node) => node.event.type === "tool/result" && node.event.data.content.startsWith(PLACEHOLDER_PREFIX));
      expect(clearedOf(madeA.value as never)).toBe(true); // A 的 L1 落账
      expect(clearedOf(madeB.value as never)).toBe(false); // B 安全区不动
    } finally {
      await world.ctx.dispose();
    }
  });
});

describe("空闲清理（时间分支）", () => {
  it("到期 + 有收益 → 定时器落账 redaction（idleClearMinutes 极小值端到端）", async () => {
    const world = await makeWorld({ idleClearMinutes: 0.001, clearKeepRecent: 0 }); // 60ms 到期；tick 自适应下限 250ms
    const cleared: string[] = [];
    world.ctx.on(autocompactL1Cleared, (payload) => cleared.push(payload.trigger));
    try {
      const made = await world.store.create({ id: sid("idle") });
      if (!made.ok) throw new Error(made.reason);
      seedToolTurn(made.value, { turn: 0, user: "go", tool: "read", callId: "c1", args: JSON.stringify({ path: "/i.ts" }), result: textOf(40) });
      seedToolTurn(made.value, { turn: 1, user: "next", tool: "read", callId: "c2", args: "{}", result: textOf(1), usage: { input: 500, output: 1 } });
      // 触达会话（建状态）后等待定时器越过到期窗
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
