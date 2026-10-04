import { describe, expect, it, vi } from "vitest";
import { BASE_OPTIONS, dispatchPreStep, emptyScript, makeWorld, promptOf, seedSystem, seedTurn, sid, textScript } from "./helpers.ts";

const FAIL_OPTIONS = { ...BASE_OPTIONS, triggerPct: 80 };

async function overThreshold(world: Awaited<ReturnType<typeof makeWorld>>, id: string) {
  const made = await world.store.create({ id: sid(id) });
  if (!made.ok) throw new Error(made.reason);
  const session = made.value;
  seedSystem(session, "SYS");
  seedTurn(session, { turn: 0, user: "first question", assistant: { text: "answer-0", usage: { input: 50, output: 5 } } });
  seedTurn(session, { turn: 1, user: "second question", assistant: { text: "answer-1", usage: { input: 950, output: 5 } } });
  return session;
}

describe("三振停机（85% 水位 compact 失败 ×3 → exhausted → reject）", () => {
  it("契约：3 次失败后 exhausted 事件恰好一次、reject 一次、后续消息零拨号直接 reject（回归：压缩失败任务继续烧 token）", { timeout: 20_000 }, async () => {
    const world = await makeWorld(FAIL_OPTIONS);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const session = await overThreshold(world, "strike3");
      for (let i = 0; i < 3; i += 1) world.llm.scripts.push(emptyScript());
      const decision = await dispatchPreStep(world, { session: session.id });
      expect(decision).toEqual({ kind: "reject", reason: "compact-exhausted" });
      expect(world.llm.calls).toHaveLength(3);
      expect(session.events().filter((e) => e.type === "compaction/exhausted")).toHaveLength(1);
      const noopDiag = session.events().filter((e) => e.type === "compaction/diagnostic" && (e.data as { code: string }).code === "trigger-noop");
      expect(noopDiag).toHaveLength(3);
      const again = await dispatchPreStep(world, { session: session.id });
      expect(again).toEqual({ kind: "reject", reason: "compact-exhausted" });
      expect(world.llm.calls).toHaveLength(3);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });

  it("边界：第 3 次成功 → 不停机、计数清零、无 exhausted 事件", { timeout: 20_000 }, async () => {
    const world = await makeWorld(FAIL_OPTIONS);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const session = await overThreshold(world, "third-ok");
      world.llm.scripts.push(emptyScript());
      world.llm.scripts.push(emptyScript());
      world.llm.scripts.push(textScript("RECOVERED"));
      const decision = await dispatchPreStep(world, { session: session.id });
      expect(decision).toEqual({ kind: "enter" });
      expect(world.llm.calls).toHaveLength(3);
      expect(session.events().some((e) => e.type === "compaction/exhausted")).toBe(false);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });

  it("manual compact 成功清除 exhausted：会话恢复放行（用户裁决：手动恢复）", { timeout: 20_000 }, async () => {
    const world = await makeWorld(FAIL_OPTIONS);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const session = await overThreshold(world, "manual-unlock");
      for (let i = 0; i < 3; i += 1) world.llm.scripts.push(emptyScript());
      await dispatchPreStep(world, { session: session.id });
      expect(session.events().some((e) => e.type === "compaction/exhausted")).toBe(true);
      const { compactionRunner } = await import("../tokens.ts");
      const runner = world.ctx.use(compactionRunner);
      world.llm.scripts.push(textScript("MANUAL-SUM"));
      const result = await runner.compact({ session: session.id });
      expect(result.ok).toBe(true);
      const decision = await dispatchPreStep(world, { session: session.id });
      expect(decision).not.toEqual({ kind: "reject", reason: "compact-exhausted" });
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });

  it("确定性失败（no-cut-point）快速三振：不退避不重试拨号（回归：10s 退避挂住 step）", async () => {
    const world = await makeWorld(FAIL_OPTIONS);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const made = await world.store.create({ id: sid("nocut") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: "only", assistant: { text: "a", usage: { input: 950, output: 5 } } });
      const t0 = Date.now();
      const decision = await dispatchPreStep(world, { session: made.value.id });
      expect(Date.now() - t0).toBeLessThan(1_500);
      expect(decision).toEqual({ kind: "reject", reason: "compact-exhausted" });
      expect(made.value.events().some((e) => e.type === "compaction/exhausted")).toBe(true);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });
});

describe("诊断落 journal（回归：924k 会话压缩静默失败无任何 journal 痕迹）", () => {
  it("契约：每次失败一条 compaction/diagnostic，原因码透传、不带一次性静默", { timeout: 20_000 }, async () => {
    const world = await makeWorld(FAIL_OPTIONS);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const session = await overThreshold(world, "diag");
      for (let i = 0; i < 3; i += 1) world.llm.scripts.push(emptyScript());
      await dispatchPreStep(world, { session: session.id });
      const diags = session.events().filter((e) => e.type === "compaction/diagnostic");
      const entries = diagEntries(diags) as unknown as Array<{ origin: string; code: string; turn: number; detail?: { attempt?: number; reason?: string } }>;
      expect(entries).toHaveLength(3);
      for (const d of entries) {
        expect(d.code).toBe("trigger-noop");
        expect(d.origin).toBe("compaction");
        expect(typeof d.turn).toBe("number");
      }
      expect(entries.map((d) => d.detail?.attempt)).toEqual([1, 2, 3]);
      expect(entries.every((d) => typeof d.detail?.reason === "string")).toBe(true);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });
});

function diagEntries(events: ReadonlyArray<{ data: unknown }>): Array<{ origin: string; code: string; turn: number }> {
  return events.map((e) => e.data as { origin: string; code: string; turn: number });
}


describe("对抗审查回归（2026-10-05 处置）", () => {
  it("用户取消不计三振：abort signal 在途压缩返回 aborted → 不置 exhausted 不 reject（回归：steer 一次即永久阻断）", { timeout: 20_000 }, async () => {
    const world = await makeWorld(FAIL_OPTIONS);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const session = await overThreshold(world, "abort-no-strike");
      const controller = new AbortController();
      controller.abort();
      const decision = await dispatchPreStep(world, { session: session.id, signal: controller.signal });
      expect(decision).toEqual({ kind: "enter" });
      expect(session.events().some((e) => e.type === "compaction/exhausted")).toBe(false);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });

  it("journal 尾部 exhausted（其后无 replace）→ 重建标记：零拨号直接 reject（回归：重启后重烧三振拨号）", { timeout: 20_000 }, async () => {
    const world = await makeWorld(FAIL_OPTIONS);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const made = await world.store.create({ id: sid("recover-fold") });
      if (!made.ok) throw new Error(made.reason);
      seedSystem(made.value, "SYS");
      seedTurn(made.value, { turn: 0, user: "q", assistant: { text: "a", usage: { input: 950, output: 5 } } });
      made.value.append("compaction/exhausted", { turn: 9, step: 0, attempts: 3 });
      world.store.dispose(made.value.id);
      const reborn = await world.store.create({ id: sid("recover-fold") });
      if (!reborn.ok) throw new Error(reborn.reason);
      reborn.value.append("compaction/exhausted", { turn: 9, step: 0, attempts: 3 });
      const decision = await dispatchPreStep(world, { session: reborn.value.id });
      expect(decision).toEqual({ kind: "reject", reason: "compact-exhausted" });
      expect(world.llm.calls).toHaveLength(0);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });
});

describe("thinking off（回归：thinking max 波及内部请求）", () => {
  it("internal:summarizer 拨号参数 thinking=off", async () => {
    const world = await makeWorld(FAIL_OPTIONS);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const session = await overThreshold(world, "think");
      world.llm.scripts.push(textScript("SUM"));
      await dispatchPreStep(world, { session: session.id });
      const call = world.llm.calls[0];
      expect(call?.thinking).toBe("off");
      expect(promptOf(call)).toContain("<conversation>");
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });
});

describe("sessionDisposed 生命周期", () => {
  it("dispose 清 exhausted：同 id 重生会话不受旧标记拖累", { timeout: 20_000 }, async () => {
    const world = await makeWorld(FAIL_OPTIONS);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const session = await overThreshold(world, "recycle2");
      for (let i = 0; i < 3; i += 1) world.llm.scripts.push(emptyScript());
      await dispatchPreStep(world, { session: session.id });
      world.store.dispose(session.id);
      const reborn = await world.store.create({ id: sid("recycle2") });
      if (!reborn.ok) throw new Error(reborn.reason);
      seedSystem(reborn.value, "SYS");
      seedTurn(reborn.value, { turn: 0, user: "q", assistant: { text: "a", usage: { input: 50, output: 5 } } });
      const decision = await dispatchPreStep(world, { session: reborn.value.id });
      expect(decision).toEqual({ kind: "enter" });
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });
});
