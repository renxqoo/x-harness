import { describe, expect, it } from "vitest";
import type { Context, GuardDeny } from "@x-harness/core";
import { createContext, loadPlugins } from "@x-harness/core";
import {
  sessionArchive,
  sessionCreateGuard,
  sessionCreated,
  sessionEvent,
  sessionFlush,
  sessionDisposed,
  sessionPlugin,
  sessionStore,
} from "../index.ts";
import type { SessionStore } from "../types.ts";
import { unwrap } from "./helpers.ts";

async function assemble(): Promise<{ ctx: Context; store: SessionStore }> {
  const ctx = createContext();
  await loadPlugins(ctx, [sessionPlugin]);
  return { ctx, store: ctx.use(sessionStore) };
}

describe("token 词表封闭（docs/SESSION.md §1.2——导出名与档位双向锁定）", () => {
  it("7 token：2 服务 + 5 总线；emit 三 token freeze=none（构造期预冻）", () => {
    expect(sessionStore).toMatchObject({ kind: "service", name: "session-store" });
    expect(sessionArchive).toMatchObject({ kind: "service", name: "session-archive" });
    expect(sessionCreateGuard).toMatchObject({ kind: "guard", mode: "guard", name: "session/create-guard" });
    expect(sessionCreated).toMatchObject({ kind: "event", mode: "emit", name: "session/created", freeze: "none" });
    expect(sessionEvent).toMatchObject({ kind: "event", mode: "emit", name: "session/event", freeze: "none" });
    expect(sessionFlush).toMatchObject({ kind: "parallel", mode: "parallel", name: "session/flush" });
    expect(sessionDisposed).toMatchObject({ kind: "event", mode: "emit", name: "session/disposed", freeze: "none" });
  });
});

describe("插件装配与总线时序（docs/SESSION.md §1.2）", () => {
  it("created 广播先于该会话一切 session/event", async () => {
    const { ctx, store } = await assemble();
    const order: string[] = [];
    ctx.on(sessionCreated, () => order.push("created"));
    ctx.on(sessionEvent, ({ event }) => order.push(`event:${String(event.seq)}`));
    const made = unwrap(await store.create());
    made.append("turn/start", { turn: 0 });
    made.append("turn/end", { turn: 0, reason: { kind: "completed" } });
    expect(order).toEqual(["created", "event:0", "event:1"]);
  });

  it("sessionEvent 载荷携带 sessionId 与已冻结事件", async () => {
    const { ctx, store } = await assemble();
    const seen: Array<{ session: string; frozen: boolean }> = [];
    ctx.on(sessionEvent, ({ session, event }) => {
      seen.push({ session, frozen: Object.isFrozen(event) && Object.isFrozen(event.data) });
    });
    const made = unwrap(await store.create());
    made.append("turn/start", { turn: 0 });
    expect(seen).toEqual([{ session: made.id, frozen: true }]);
  });

  it("guard 否决集成：deny → create 失败且 created 不广播", async () => {
    const { ctx, store } = await assemble();
    let createdCount = 0;
    ctx.on(sessionCreated, () => {
      createdCount += 1;
    });
    const off = ctx.on(sessionCreateGuard, (): GuardDeny => ({ kind: "deny", reason: "quota" }));
    expect(await store.create()).toEqual({ ok: false, reason: "denied:quota" });
    off();
    expect(unwrap(await store.create()).id.length).toBeGreaterThan(0);
    expect(createdCount).toBe(1);
  });

  it("flush 空屏障：无监听立即成功；监听抛错经 parallel 聚合上浮", async () => {
    const { ctx, store } = await assemble();
    const s = unwrap(await store.create());
    expect(await store.flush(s.id)).toEqual({ ok: true, value: { flushed: true } });
    const off = ctx.on(sessionFlush, async () => {
      throw new Error("io");
    });
    expect(await store.flush(s.id)).toEqual({ ok: false, reason: "flush-failed:io" });
    off();
    expect(await store.flush(s.id)).toEqual({ ok: true, value: { flushed: true } });
  });

  it("多监听器同时失败：AggregateError 展开后原因全保留（症状：曾只见 parallel dispatch failures）", async () => {
    const { ctx, store } = await assemble();
    const s = unwrap(await store.create());
    const off1 = ctx.on(sessionFlush, async () => {
      throw new Error("e1");
    });
    const off2 = ctx.on(sessionFlush, async () => {
      throw new Error("e2");
    });
    const flushed = await store.flush(s.id);
    expect(flushed.ok).toBe(false);
    if (!flushed.ok) {
      expect(flushed.reason).toContain("e1");
      expect(flushed.reason).toContain("e2");
    }
    off1();
    off2();
  });

  it("dispose 广播恰好一次", async () => {
    const { ctx, store } = await assemble();
    const disposed: string[] = [];
    ctx.on(sessionDisposed, ({ session }) => disposed.push(session));
    const s = unwrap(await store.create());
    store.dispose(s.id);
    expect(disposed).toEqual([s.id]);
  });

  it("ctx.dispose → 插件卸载清空全部会话", async () => {
    const { ctx, store } = await assemble();
    unwrap(await store.create());
    unwrap(await store.create());
    expect(store.list()).toHaveLength(2);
    await ctx.dispose();
    expect(store.list()).toEqual([]);
  });
});
