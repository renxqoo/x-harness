// get_entries view 域集成测试（docs/SESSION.md 三视图分域）：真 idle-clear 旅程
// （真 session 落账 + maybeIdleClear 真触发——非手写 replace 合成）、burst 护栏、
// history 增量等式、双站点（entryWindowViewed 单入口）恒等、无 view golden。
// 装置复用 autocompact helpers（真 sessionStore + seedToolTurn + makeSessionState）。
import { describe, expect, test } from "vitest";
import { maybeIdleClear, makeSessionState } from "@x-harness/autocompact";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { Session, SessionEvent, SessionId } from "@x-harness/session";
import { createContext, loadPlugins } from "@x-harness/core";
import { entryWindow, entryWindowViewed } from "../worker/entries-window.ts";
import { projectEntries } from "../shared/entries-project.ts";
import { seedToolTurn, sid } from "../../../../packages/autocompact/src/__test__/helpers.ts";

async function realSession(id: SessionId): Promise<Session> {
  const ctx = createContext();
  await loadPlugins(ctx, [sessionPlugin]);
  const store = ctx.use(sessionStore);
  const made = await store.create({ id });
  if (!made.ok) throw new Error(`create failed: ${String(made.reason)}`);
  return made.value;
}

/** 真工具轮 ×N → maybeIdleClear 真触发（clearableTools 白名单 + keepRecent 0） */
async function sessionAfterIdleClear(n: number): Promise<Session> {
  const session = await realSession(sid("view-domain"));
  for (let i = 0; i < n; i += 1) {
    seedToolTurn(session, {
      turn: i,
      user: `u${String(i)}`,
      tool: "read",
      callId: `c${String(i)}`,
      args: "{\"path\":\"/x\"}",
      result: `result-content-${String(i)}-`.repeat(8),
    });
  }
  const state = makeSessionState(sid("view-domain"));
  state.lastTurnEndAt = Date.now() - 3_600_000; // 60 分钟前到期
  const landed = maybeIdleClear({
    session,
    state,
    config: { clearableTools: ["read"], clearKeepRecent: 0, idleClearMinutes: 1, idleClearMinGainTokens: 0 },
    now: Date.now(),
    warn: () => {},
    flush: async () => ({ ok: true }),
    emitL1Cleared: () => {},
  } as never);
  expect(landed).toBe(true);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 5);
  });
  return session;
}

describe("get_entries view 域：真 idle-clear 旅程", () => {
  test("L1 落账后：history 无占位载体行、journal 全量、leafSeq 恒 journal 尾", async () => {
    const session = await sessionAfterIdleClear(5);
    const events = session.events();
    const carriers = events.filter((e) => typeof e.surfaceOp === "object" && e.surfaceOp !== null && e.surfaceOp.op === "replace");
    // 5 轮工具轮：末轮在飞轮（lastTurnStartIndex 之后）整轮豁免 → 载体 = 前 4 轮
    expect(carriers.length).toBe(4);

    const journal = entryWindowViewed(events, {});
    expect(journal.ok && journal.entries).toHaveLength(events.length);
    const history = entryWindowViewed(events, { view: "history" });
    expect(history.ok && history.entries).toHaveLength(events.length - 4);
    expect(history.ok && history.leafSeq).toBe(journal.ok ? journal.leafSeq : -1); // 全集域
    // history 中不得出现占位文案，且原文仍在
    const contents = JSON.stringify(history.ok ? history.entries : []);
    expect(contents).not.toContain("[cleared:");
    expect(contents).toContain("result-content-0-");
  });

  test("等式断言：history 全量 ≡ journal 全量减载体行（增量拼接防丢行）", async () => {
    const session = await sessionAfterIdleClear(6);
    const events = session.events();
    const full = entryWindowViewed(events, { view: "history" });
    if (!full.ok) throw new Error("window failed");
    // 自零起逐段增量拉取（leafSeq 上限内）
    const pulled: typeof full.entries = [];
    let cursor: number | undefined;
    for (;;) {
      const r = entryWindowViewed(events, { ...(cursor === undefined ? {} : { since: cursor }), view: "history" });
      if (!r.ok) throw new Error(`incremental pull failed: ${r.reason}`);
      pulled.push(...r.entries);
      if (r.entries.length === 0 || (pulled.at(-1)?.seq ?? 0) >= r.leafSeq) break;
      const lastSeq = r.entries.at(-1)?.seq;
      if (lastSeq === undefined || r.leafSeq <= lastSeq) break;
      cursor = lastSeq;
    }
    expect(pulled.map((e) => e.seq)).toEqual(full.entries.map((e) => e.seq));
  });

  test("burst 护栏：263 载体行规模下 history 视图行数正确且耗时 < 500ms", async () => {
    const session = await realSession(sid("view-burst"));
    for (let i = 0; i < 263; i += 1) {
      seedToolTurn(session, {
        turn: i,
        user: `u${String(i)}`,
        tool: "read",
        callId: `c${String(i)}`,
        args: "{\"path\":\"/x\"}",
        result: `r-${String(i)}-`.repeat(4),
      });
    }
    const state = makeSessionState(sid("view-burst"));
    state.lastTurnEndAt = Date.now() - 3_600_000;
    maybeIdleClear({
      session,
      state,
      config: { clearableTools: ["read"], clearKeepRecent: 0, idleClearMinutes: 1, idleClearMinGainTokens: 0 },
      now: Date.now(),
      warn: () => {},
      flush: async () => ({ ok: true }),
      emitL1Cleared: () => {},
    } as never);
    await new Promise<void>((resolve) => {
    setTimeout(resolve, 5);
  });
    const events = session.events();
    const t0 = Date.now();
    const history = entryWindowViewed(events, { view: "history" });
    const elapsed = Date.now() - t0;
    expect(history.ok && history.entries.length).toBe(events.length - 262); // 末轮在飞轮豁免
    expect(elapsed).toBeLessThan(500);
  });
});

describe("get_entries view 域：窗口与失败族", () => {
  const mk = (): SessionEvent[] =>
    [
      { type: "user/message", seq: 0, time: 1, data: { content: [] }, surfaceOp: "append" },
      { type: "tool/result", seq: 1, time: 2, data: { callId: "c", content: "原文" }, surfaceOp: "append" },
      { type: "tool/result", seq: 2, time: 3, data: { callId: "c", content: "[cleared: read x 5 chars]" }, surfaceOp: { op: "replace", startSeq: 1, endSeq: 1 } },
      { type: "assistant/message", seq: 3, time: 4, data: { content: [] }, surfaceOp: "append" },
    ] as never as SessionEvent[];

  test("游标指向被滤载体行仍合法（全集域校验）——history 返回跳过该行不空洞", () => {
    const r = entryWindowViewed(mk(), { since: 1, view: "history" });
    expect(r.ok && r.entries.map((e) => e.seq)).toEqual([3]); // 载体 2 滤除，非 cursor_stale
  });

  test("无 view 参数 golden：响应与 projectEntries+entryWindow 现状路径字节等同", () => {
    const events = mk();
    const viaViewed = entryWindowViewed(events, {});
    // 复刻改动前 live 路径：projectEntries → entryWindow（无 view）
    const legacy = entryWindow(projectEntries(events), {});
    expect(JSON.stringify(viaViewed)).toBe(JSON.stringify(legacy));
  });

  test("非法 view 显式 invalid_input；limit 截断后滤（limit=N 不保证 N 条）", () => {
    const bad = entryWindowViewed(mk(), { view: "Journal" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("invalid_input");
    const limited = entryWindowViewed(mk(), { limit: 2, view: "history" });
    // 全集最近 2 条 = seq 2,3 → history 变换后只剩 3（载体 2 滤除）
    expect(limited.ok && limited.entries.map((e) => e.seq)).toEqual([3]);
    expect(limited.ok && limited.hasMore).toBe(true); // journal 域真值
  });
});
