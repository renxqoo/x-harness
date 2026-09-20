// 单飞行与生命周期（join 语义/世代门/紧急自愈并发——docs/COMPACTION.md §2.B）
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
      expect(second.ok).toBe(true); // join：共享在飞结果而非拒绝
      expect((await first).ok).toBe(true);
      expect(world.llm.calls).toHaveLength(1); // 单拨号
      expect(made.value.events().filter((e) => typeof e.surfaceOp === "object")).toHaveLength(1); // 单落账
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
      const first = world.ctx.use(compactionRunner).compact({ session: made.value.id }); // 旧世代在飞
      world.store.dispose(made.value.id); // 切走(reopen/dispose)
      const reborn = await world.store.create({ id: sid("gen") }); // 同 id 重生
      if (!reborn.ok) throw new Error(reborn.reason);
      seedTurn(reborn.value, { turn: 0, user: "r0", assistant: { text: "b0", usage: { input: 100, output: 5 } } });
      seedTurn(reborn.value, { turn: 1, user: "r1", assistant: { text: "b1", usage: { input: 100, output: 5 } } });
      world.llm.scripts.push(textScript("new-flight"));
      const second = await world.ctx.use(compactionRunner).compact({ session: reborn.value.id });
      expect(second.ok).toBe(true); // 不 join 旧飞行——旧结果 session-unknown 不得泄漏到活会话
      expect((await first).ok).toBe(false); // 旧飞行被世代门拦截（落账侧比对——不得跨代写）
      expect(reborn.value.events().some((e) => typeof e.surfaceOp === "object")).toBe(true); // 新飞行真的落账
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
      const first = world.ctx.use(compactionRunner).compact({ session: made.value.id }); // 旧世代在飞
      world.store.dispose(made.value.id); // 世代推进(同步 emit)
      const reborn = await world.store.create({ id: sid("gen2") }); // 同 id 重生
      if (!reborn.ok) throw new Error(reborn.reason);
      seedTurn(reborn.value, { turn: 0, user: "r0", assistant: { text: "b0", usage: { input: 100, output: 5 } } });
      seedTurn(reborn.value, { turn: 1, user: "r1", assistant: { text: "b1", usage: { input: 100, output: 5 } } });
      const outcome = await first; // 旧飞行 summarize 完成、先于新会话任何压缩落账
      expect(outcome).toEqual({ ok: false, reason: "session-unknown" }); // 落账侧世代门:旧摘要被丢弃
      expect(JSON.stringify(reborn.value.surface())).not.toContain("OLD-SUMMARY"); // 污染未发生
      expect(reborn.value.events().some((e) => typeof e.surfaceOp === "object")).toBe(false); // 无跨代 replace
    } finally {
      await world.ctx.dispose();
    }
  });

  it("回归:413 自愈等待在飞 auto 飞行落定后以 keep=0 新飞(不 join——join 拿不到激进参数)", async () => {
    const world = await makeWorld({ keepRecentTokens: 30_000 }); // auto 折大粘贴轮即止,留三个短轮给 emergency
    try {
      const made = await world.store.create({ id: sid("em") });
      if (!made.ok) throw new Error(made.reason);
      // 两大粘贴轮 + 两短轮:auto(keep=30k)折 turn0;emergency(keep=0)折 [summary,turn1]
      // ——两飞行都真实拨号(单一轮起点会被无进展护栏拒——首候选不可为切口)
      seedTurn(made.value, { turn: 0, user: "长".repeat(30_000), assistant: { text: "a0", usage: { input: 100, output: 5 } } });
      seedTurn(made.value, { turn: 1, user: "宽".repeat(30_000), assistant: { text: "a1", usage: { input: 100, output: 5 } } });
      for (let turn = 2; turn < 4; turn += 1) {
        seedTurn(made.value, { turn, user: `e${String(turn)}`, assistant: { text: `a${String(turn)}`, usage: { input: 100, output: 5 } } });
      }
      // 在飞 auto 压缩(慢摘要)——模拟水位飞行进行中
      world.llm.scripts.push(slowScript("auto-summary", 40));
      const inflightAuto = world.ctx.use(compactionRunner).compact({ session: made.value.id });
      // 同一 (turn,step) 到达 413 → 自愈路径:先等 auto 落定,再 keep=0 新飞
      world.llm.scripts.push(textScript("emergency-summary"));
      const { agentRequestError } = await import("@x-harness/agent-loop");
      await world.ctx.dispatch(
        agentRequestError,
        { session: made.value.id, turn: 5, step: 0, failure: { code: "http-413", message: "too large" }, signal: new AbortController().signal } as never,
        async () => undefined as never,
      );
      const auto = await inflightAuto;
      expect(auto.ok).toBe(true); // auto 飞行正常落定(未被自愈打断)
      expect(world.llm.calls).toHaveLength(2); // 两拨号:auto + emergency(非 join 单拨号)
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
      // 单轮会话：唯一真轮起点必须保留 → 无进展
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
