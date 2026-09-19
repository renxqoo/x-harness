// W3「模型可见必落盘」不变量断言（docs/ELEVATION-MIGRATION-W3 §3 三口径）：
// 开态一致零动作 / 开态失配 throw（fail-loud）/ 关态零介入（含失配也不炸——默认生产形态）。

import { describe, expect, it, afterEach } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { Session } from "@x-harness/session";
import { assertVisibleLogged, observePrompt } from "../step.ts";

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
