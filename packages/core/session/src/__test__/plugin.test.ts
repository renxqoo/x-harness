import { describe, expect, it } from "vitest";
import type { Context, GuardDeny } from "@x-harness/core";
import { createContext, loadPlugins } from "@x-harness/core";
import {
  sessionArchive,
  sessionAuditDrain,
  sessionAuditEvent,
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
  it("9 token：3 服务 + 6 总线；emit 三 token freeze=none（构造期预冻）", () => {
    expect(sessionStore).toMatchObject({ kind: "service", name: "session-store" });
    expect(sessionArchive).toMatchObject({ kind: "service", name: "session-archive" });
    expect(sessionAuditDrain).toMatchObject({ kind: "service", name: "session-audit-drain" });
    expect(sessionCreateGuard).toMatchObject({ kind: "guard", mode: "guard", name: "session/create-guard" });
    expect(sessionCreated).toMatchObject({ kind: "event", mode: "emit", name: "session/created", freeze: "none" });
    expect(sessionEvent).toMatchObject({ kind: "event", mode: "emit", name: "session/event", freeze: "none" });
    expect(sessionAuditEvent).toMatchObject({ kind: "event", mode: "emit", name: "session/audit-event", freeze: "none" });
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
    expect(await store.flush(s.id)).toEqual({ ok: true, value: true });
    const off = ctx.on(sessionFlush, async () => {
      throw new Error("io");
    });
    expect(await store.flush(s.id)).toEqual({ ok: false, reason: "flush-failed:io" });
    off();
    expect(await store.flush(s.id)).toEqual({ ok: true, value: true });
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

describe("双通道（docs/SESSION.md §1.2：UI 同步观察面 + 审计微任务投递面）", () => {
  it("sessionEvent 同步送达；sessionAuditEvent 微任务后送达且 FIFO 保序", async () => {
    const { ctx, store } = await assemble();
    const uiSeen: number[] = [];
    const auditSeen: number[] = [];
    ctx.on(sessionEvent, ({ event }) => uiSeen.push(event.seq));
    ctx.on(sessionAuditEvent, ({ event }) => auditSeen.push(event.seq));
    const made = unwrap(await store.create());
    made.append("turn/start", { turn: 0 });
    made.append("turn/end", { turn: 0, reason: { kind: "completed" } });
    expect(uiSeen).toEqual([0, 1]); // UI 通道：append 返回前同步
    expect(auditSeen).toEqual([]); // 审计通道：此刻必未投递（微任务级）
    await Promise.resolve(); // 让渡微任务队列
    expect(auditSeen).toEqual([0, 1]); // FIFO 保序、不丢不重
  });

  it("flush 结构排空：sessionFlush 派发前残余审计事件必已投递", async () => {
    const { ctx, store } = await assemble();
    const order: string[] = [];
    ctx.on(sessionAuditEvent, ({ event }) => order.push(`audit:${String(event.seq)}`));
    ctx.on(sessionFlush, () => order.push("flush"));
    const made = unwrap(await store.create());
    made.append("turn/start", { turn: 0 }); // 微任务尚未跑（同步紧邻 flush——契约最紧路径）
    await store.flush(made.id);
    expect(order).toEqual(["audit:0", "flush"]); // 结构性保证：不依赖微任务时序
  });

  it("drain 端口：同步排空立即可见，且与微任务投递不重复", async () => {
    const { ctx, store } = await assemble();
    const auditSeen: number[] = [];
    ctx.on(sessionAuditEvent, ({ event }) => auditSeen.push(event.seq));
    const made = unwrap(await store.create());
    made.append("turn/start", { turn: 0 });
    ctx.use(sessionAuditDrain).drain();
    expect(auditSeen).toEqual([0]); // 不等微任务
    await Promise.resolve(); // 原子 swap：已排空的微任务不重复投递
    made.append("turn/end", { turn: 0, reason: { kind: "completed" } });
    await Promise.resolve();
    expect(auditSeen).toEqual([0, 1]); // 排空后新事件照常微任务投递
  });

  it("contextDisposing 排空：dispose 同步段残余审计事件仍可达监听器", async () => {
    const { ctx, store } = await assemble();
    const auditSeen: number[] = [];
    ctx.on(sessionAuditEvent, ({ event }) => auditSeen.push(event.seq));
    const made = unwrap(await store.create());
    made.append("turn/start", { turn: 0 }); // 微任务未跑即 dispose——回卷最先广播时排空
    void made;
    await ctx.dispose();
    expect(auditSeen).toEqual([0]);
  });

  it("投递循环内监听器 append + flush 重入：投递序恒 = 日志序（回归：重入早投递曾破 FIFO 致乱序卷）", async () => {
    const { ctx, store } = await assemble();
    const made = unwrap(await store.create());
    const order: number[] = [];
    let flushed: { ok: boolean } | undefined;
    const midBatchAppend = (seq: number): void => {
      // 批次中段 append（seq 2 入队尾）+ 重入排空（onFlush→deliverAudit）+ 屏障发起——PoC B 同款
      if (seq !== 0) return;
      made.append("turn/start", { turn: 1 });
      void store
        .flush(made.id)
        .then((result) => {
          flushed = result;
        })
        .catch(() => {});
    };
    ctx.on(sessionAuditEvent, ({ event }) => {
      order.push(event.seq);
      midBatchAppend(event.seq);
    });
    made.append("turn/start", { turn: 0 });
    made.append("turn/end", { turn: 0, reason: { kind: "completed" } }); // 投递批次 [0,1]
    await new Promise((resolve) => {
      setImmediate(resolve); // 让尽微任务（投递循环 + 重入屏障的 drain 段）
    });
    expect(order).toEqual([0, 1, 2]); // 批次中段 append 的事件续排本批之后——重入不得提前投递
    expect(flushed).toEqual({ ok: true, value: true }); // 重入屏障照常成功
  });

  it("审计载荷与 UI 通道同形同冻（构造期预冻共享）", async () => {
    const { ctx, store } = await assemble();
    let ui: { session: string; frozen: boolean } | undefined;
    let audit: { session: string; frozen: boolean } | undefined;
    ctx.on(sessionEvent, ({ session, event }) => {
      ui = { session, frozen: Object.isFrozen(event) && Object.isFrozen(event.data) };
    });
    ctx.on(sessionAuditEvent, ({ session, event }) => {
      audit = { session, frozen: Object.isFrozen(event) && Object.isFrozen(event.data) };
    });
    const made = unwrap(await store.create());
    made.append("turn/start", { turn: 0 });
    await Promise.resolve();
    expect(ui).toEqual(audit);
    expect(audit).toMatchObject({ session: made.id, frozen: true });
  });
});
