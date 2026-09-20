// W3「模型可见必落盘」不变量断言（docs/ELEVATION-MIGRATION-W3 §3 三口径）：
// 开态一致零动作 / 开态失配 throw（fail-loud）/ 关态零介入（含失配也不炸——默认生产形态）。

import { describe, expect, it, afterEach } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { Session } from "@x-harness/session";
import { assertVisibleLogged, anchorSystem, observePrompt } from "../step.ts";
import type { TurnScope } from "../step.ts";
import { systemPrompt, systemPromptPlugin } from "@x-harness/system-prompt";
import type { SystemPromptService } from "@x-harness/system-prompt";

const ENV_KEY = "X_HARNESS_ASSERT_VISIBLE";
const had = process.env[ENV_KEY];
afterEach(() => {
  if (had === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = had;
});

async function makeSession(): Promise<Session> {
  const ctx = createContext();
  await loadPlugins(ctx, [sessionPlugin]);
  const made = await ctx.use(sessionStore).create({ id: "w3-inv" as never });
  if (!made.ok) throw new Error(made.reason);
  return made.value;
}

describe("assertVisibleLogged（W3 不变量）", () => {
  it("开态：落盘与投影一致 → 零动作（含空文本 dormant 形态）", async () => {
    process.env[ENV_KEY] = "1";
    const session = await makeSession();
    const r = session.append("system/message", { turn: 0, step: 0, text: "SYS" } as never, { surfaceOp: "append" } as never);
    expect(r.ok).toBe(true);
    expect(() => assertVisibleLogged(session, "SYS")).not.toThrow();
  });

  it("开态：投影与提交文本失配 → throw（fail-loud，不变量违例非降级）", async () => {
    process.env[ENV_KEY] = "1";
    const session = await makeSession();
    const r = session.append("system/message", { turn: 0, step: 0, text: "STALE" } as never, { surfaceOp: "append" } as never);
    expect(r.ok).toBe(true);
    expect(() => assertVisibleLogged(session, "FRESH")).toThrow(/visible-logged invariant violated/);
  });

  it("关态（缺省生产形态）：失配也不介入——断言面零开销短路", async () => {
    delete process.env[ENV_KEY];
    const session = await makeSession();
    const r = session.append("system/message", { turn: 0, step: 0, text: "STALE" } as never, { surfaceOp: "append" } as never);
    expect(r.ok).toBe(true);
    expect(() => assertVisibleLogged(session, "FRESH")).not.toThrow();
  });
});

describe("observePrompt（W3 指纹观测线）", () => {
  it("开态：stderr 输出 fingerprint+changed 行（sha256 前 16 hex）", () => {
    process.env[ENV_KEY] = "1";
    const chunks: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((s: string) => { chunks.push(s); return true; }) as typeof process.stderr.write;
    try {
      observePrompt({ turn: 1, step: 2, text: "hello", changed: true });
    } finally {
      process.stderr.write = original;
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatch(/^\[prompt\] turn=1 step=2 fingerprint=[0-9a-f]{16} changed=true\n$/);
  });

  it("关态：零输出（生产形态零开销短路）", () => {
    delete process.env[ENV_KEY];
    const chunks: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((s: string) => { chunks.push(s); return true; }) as typeof process.stderr.write;
    try {
      observePrompt({ turn: 1, step: 2, text: "hello", changed: false });
    } finally {
      process.stderr.write = original;
    }
    expect(chunks).toHaveLength(0);
  });
});

// —— anchorSystem 级集成（W3 挂账收口：静态串口径 / no-op 漂移 / replace 路径）——
// TurnScope 手工构造——不需要完整 driver（anchorSystem 只读 deps 的四项面）。



interface AnchorFixture {
  session: Session;
  prompt: SystemPromptService;
  cleanup: () => Promise<void>;
}

async function makeAnchorFixture(): Promise<AnchorFixture> {
  const ctx = createContext();
  await loadPlugins(ctx, [sessionPlugin, systemPromptPlugin]);
  const prompt = ctx.use(systemPrompt);
  const store = ctx.use(sessionStore);
  const made = await store.create({ id: "w3-anchor" as never });
  if (!made.ok) throw new Error(made.reason);
  return {
    session: made.value,
    prompt,
    cleanup: async () => {
      await ctx.dispose();
    },
  };
}

function scopeOf(f: AnchorFixture, systemPromptOverride?: string): TurnScope {
  return {
    deps: {
      session: f.session,
      options: { maxParallelToolCalls: 1, maxToolResultChars: 10000, ...(systemPromptOverride !== undefined ? { systemPrompt: systemPromptOverride } : {}) },
      prompt: f.prompt,
      llm: undefined as never,
      tools: undefined as never,
      emitStatus: () => {},
      emitError: () => {},
      emitStreamFrame: () => {},
      dispatchPreStep: async (_p: unknown) => ({ kind: "enter" }),
      dispatchRequest: async (_p: unknown, dial: unknown) => dial as never,
      dispatchRequestError: async () => undefined,
      dispatchTurnStopping: async () => {},
      dispatchAssistantSettle: async (p: unknown) => p,
      dispatchLlmStream: async (_r: unknown) => { throw new Error("not used"); },
    } as never,
    controller: new AbortController(),
    turn: 1,
  };
}

describe("anchorSystem 级集成（W3 挂账收口——TurnScope 手工构造）", () => {
  it("静态串口径：options.systemPrompt 在场 → 落账与投影均等于静态串（assemble 不参与）", async () => {
    process.env[ENV_KEY] = "1";
    const f = await makeAnchorFixture();
    try {
      f.prompt.section({ name: "noise", text: "SHOULD-NOT-APPEAR" }); // 装配内容存在但被静态串短路
      anchorSystem(scopeOf(f, "STATIC-OVERRIDE"), 1);
      const projected = f.session.deriveMessages().filter((m) => m.role === "system").map((m) => (m as { text?: string }).text ?? "").join("");
      expect(projected).toBe("STATIC-OVERRIDE"); // 落账=静态串（assemble 未被咨询）
      expect(projected).not.toContain("SHOULD-NOT-APPEAR");
      expect(() => assertVisibleLogged(f.session, "STATIC-OVERRIDE")).not.toThrow(); // 口径①：比对对象=静态串
    } finally {
      delete process.env[ENV_KEY];
      await f.cleanup();
    }
  });

  it("fn 段漂移 → replace 路径：步间文本变 → 锚点被替换为新版（非 no-op）", async () => {
    const f = await makeAnchorFixture();
    try {
      let tick = 1;
      const off = f.prompt.section({ name: "lazy", text: () => `TICK=${String(tick)}` });
      anchorSystem(scopeOf(f), 1); // 首步 append TICK=1
      tick = 2;
      anchorSystem(scopeOf(f), 2); // 次步 replace → TICK=2
      const all = f.session.events().filter((e) => e.type === "system/message");
      const texts = all.map((e) => (e.data as { text?: string }).text ?? "");
      expect(texts.some((t) => t.includes("TICK=2"))).toBe(true); // replace 生效（fn 漂移被探测）
      expect(texts.filter((t) => t.includes("TICK=1")).length).toBe(1); // 旧版仍在事件日志（replace 只改 surface 不删事件）
      off();
      await f.cleanup();
    } catch (e) {
      await f.cleanup();
      throw e;
    }
  });

  it("no-op 分支：文本未变 → 无新事件（确定性锚定）；assertVisibleLogged 仍验当前装配", async () => {
    process.env[ENV_KEY] = "1";
    const f = await makeAnchorFixture();
    try {
      f.prompt.section({ name: "steady", text: "SAME" });
      anchorSystem(scopeOf(f), 1); // append
      const countAfterFirst = f.session.surface().filter((n) => n.event.type === "system/message").length;
      anchorSystem(scopeOf(f), 2); // 同文本 → no-op（无新 surface 事件）
      const countAfterSecond = f.session.surface().filter((n) => n.event.type === "system/message").length;
      expect(countAfterSecond).toBe(countAfterFirst); // no-op 确认
      expect(() => assertVisibleLogged(f.session, f.prompt.assemble({ sessionId: f.session.id }).text)).not.toThrow(); // 投影=当前装配
    } finally {
      delete process.env[ENV_KEY];
      await f.cleanup();
    }
  });
});
