import { describe, expect, it, vi } from "vitest";
import { compactionRunner } from "../tokens.ts";
import { dispatchPreStep, makeWorld, seedTurn, sid, slowScript, textScript } from "./helpers.ts";

describe("单飞行与生命周期", () => {
  it("并发 compact join 在飞者共享同一结果（单落账、单拨号——参照系缺口修复回归）", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("sf") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: "s0", assistant: { text: "a0", usage: { input: 100, output: 5 } } });
      seedTurn(made.value, { turn: 1, user: "s1", assistant: { text: "a1", usage: { input: 100, output: 5 } } });
      world.llm.scripts.push(slowScript("slow", 30));
      const runner = world.ctx.use(compactionRunner);
      const first = runner.compact({ session: made.value.id });
      const second = await runner.compact({ session: made.value.id });
      expect(second.ok).toBe(true);
      expect((await first).ok).toBe(true);
      expect(world.llm.calls).toHaveLength(1);
      expect(made.value.events().filter((e) => typeof e.surfaceOp === "object")).toHaveLength(1);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("回归:同 id 重生会话不 join 已 dispose 世代的在飞飞行(活会话误报 session closed)", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("gen") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: "s0", assistant: { text: "a0", usage: { input: 100, output: 5 } } });
      seedTurn(made.value, { turn: 1, user: "s1", assistant: { text: "a1", usage: { input: 100, output: 5 } } });
      world.llm.scripts.push(slowScript("old-flight", 30));
      const first = world.ctx.use(compactionRunner).compact({ session: made.value.id });
      world.store.dispose(made.value.id);
      const reborn = await world.store.create({ id: sid("gen") });
      if (!reborn.ok) throw new Error(reborn.reason);
      seedTurn(reborn.value, { turn: 0, user: "r0", assistant: { text: "b0", usage: { input: 100, output: 5 } } });
      seedTurn(reborn.value, { turn: 1, user: "r1", assistant: { text: "b1", usage: { input: 100, output: 5 } } });
      world.llm.scripts.push(textScript("new-flight"));
      const second = await world.ctx.use(compactionRunner).compact({ session: reborn.value.id });
      expect(second.ok).toBe(true);
      expect((await first).ok).toBe(false);
      expect(reborn.value.events().some((e) => typeof e.surfaceOp === "object")).toBe(true);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("回归:旧世代飞行先于新会话压缩落账——世代门拦截跨代写(旧摘要不得污染重生会话)", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("gen2") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: "s0", assistant: { text: "a0", usage: { input: 100, output: 5 } } });
      seedTurn(made.value, { turn: 1, user: "s1", assistant: { text: "a1", usage: { input: 100, output: 5 } } });
      world.llm.scripts.push(slowScript("OLD-SUMMARY", 40));
      const first = world.ctx.use(compactionRunner).compact({ session: made.value.id });
      world.store.dispose(made.value.id);
      const reborn = await world.store.create({ id: sid("gen2") });
      if (!reborn.ok) throw new Error(reborn.reason);
      seedTurn(reborn.value, { turn: 0, user: "r0", assistant: { text: "b0", usage: { input: 100, output: 5 } } });
      seedTurn(reborn.value, { turn: 1, user: "r1", assistant: { text: "b1", usage: { input: 100, output: 5 } } });
      const outcome = await first;
      expect(outcome).toEqual({ ok: false, reason: "session-unknown" });
      expect(JSON.stringify(reborn.value.surface())).not.toContain("OLD-SUMMARY");
      expect(reborn.value.events().some((e) => typeof e.surfaceOp === "object")).toBe(false);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("回归:413 自愈等待在飞 auto 飞行落定后以 keep=0 新飞(不 join——join 拿不到激进参数)", async () => {
    const world = await makeWorld({ keepRecentTokens: 30_000 });
    try {
      const made = await world.store.create({ id: sid("em") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: "长".repeat(30_000), assistant: { text: "a0", usage: { input: 100, output: 5 } } });
      seedTurn(made.value, { turn: 1, user: "宽".repeat(30_000), assistant: { text: "a1", usage: { input: 100, output: 5 } } });
      for (let turn = 2; turn < 4; turn += 1) {
        seedTurn(made.value, { turn, user: `e${String(turn)}`, assistant: { text: `a${String(turn)}`, usage: { input: 100, output: 5 } } });
      }
      world.llm.scripts.push(slowScript("auto-summary", 40));
      const inflightAuto = world.ctx.use(compactionRunner).compact({ session: made.value.id });
      world.llm.scripts.push(textScript("emergency-summary"));
      const { agentRequestError } = await import("@x-harness/agent-loop");
      await world.ctx.dispatch(
        agentRequestError,
        { session: made.value.id, turn: 5, step: 0, failure: { code: "http-413", message: "too large" }, signal: new AbortController().signal } as never,
        async () => undefined as never,
      );
      const auto = await inflightAuto;
      expect(auto.ok).toBe(true);
      expect(world.llm.calls).toHaveLength(2);
      expect(made.value.events().filter((e) => typeof e.surfaceOp === "object").length).toBeGreaterThanOrEqual(1);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("未知会话 → session-unknown；sessionDisposed 后同形", async () => {
    const world = await makeWorld();
    try {
      const runner = world.ctx.use(compactionRunner);
      expect(await runner.compact({ session: sid("ghost") })).toEqual({ ok: false, reason: "session-unknown" });
      const made = await world.store.create({ id: sid("gone") });
      if (!made.ok) throw new Error(made.reason);
      world.store.dispose(made.value.id);
      expect(await runner.compact({ session: made.value.id })).toEqual({ ok: false, reason: "session-unknown" });
    } finally {
      await world.ctx.dispose();
    }
  });

  it("空会话 / 无可切 → no-cut-point；阈值成立未落账 → trigger-noop 一次性告警", async () => {
    const world = await makeWorld();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const made = await world.store.create({ id: sid("noop") });
      if (!made.ok) throw new Error(made.reason);
      const runner = world.ctx.use(compactionRunner);
      expect(await runner.compact({ session: made.value.id })).toEqual({ ok: false, reason: "no-cut-point" });
      seedTurn(made.value, { turn: 0, user: "only", assistant: { text: "a", usage: { input: 950, output: 5 } } });
      await dispatchPreStep(world, { session: made.value.id });
      await dispatchPreStep(world, { session: made.value.id });
      const warns = stderr.mock.calls.filter((line) => String(line[0]).includes("trigger-noop"));
      expect(warns).toHaveLength(1);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });
});
