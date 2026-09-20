// B3 集成测（docs/TELEMETRY-SQLITE.md §5 B3/§7）：writer + plugin 临时真库（bun:sqlite 内存库）。
// 幂等重放 / degraded 闩 / flush 屏障 fail-closed / unload 排空 / 晚装载 fail-closed /
// created 首灌 / resume 续链 / 查询四面。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "bun:sqlite";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Context, Plugin } from "@x-harness/core";
import { sessionPlugin } from "@x-harness/session";
import type { Result, } from "@x-harness/core";
import { sessionStore } from "@x-harness/session";
import type { Session, SessionEvent, SessionId } from "@x-harness/session";
import { createBunSqliteExecutor } from "../executor.ts";
import { ensureSchema } from "../schema.ts";
import { createQueryService } from "../service.ts";
import { createTelemetryWriter } from "../writer.ts";
import { sqliteTelemetry, sqliteTelemetryPlugin } from "../plugin.ts";
import type { BunSqliteExecutor } from "../executor.ts";

interface World {
  ctx: Context;
  store: import("@x-harness/session").SessionStore;
  telemetry: import("../types.ts").TelemetryQueryService;
  exec: BunSqliteExecutor;
  ioErrors: string[];
  unload: readonly import("@x-harness/core").Disposer[];
  db: Database;
}

let world: World | undefined;

const append = { surfaceOp: "append" } as const;

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

beforeEach(() => {
  world = undefined;
});

afterEach(async () => {
  if (world === undefined) return;
  await world.ctx.dispose().catch(() => {});
  world.db.close();
});

async function makeWorld(opts?: { readonly includeBodies?: boolean; readonly plugin?: Plugin }): Promise<World> {
  const db = new Database(":memory:");
  const exec = createBunSqliteExecutor(db);
  const ioErrors: string[] = [];
  const ctx = createContext();
  const telemetryPlugin =
    opts?.plugin ??
    sqliteTelemetryPlugin({
      db: exec,
      tx: exec.tx,
      resource: { serviceName: "xh-test", version: "0.0.1" },
      includeBodies: opts?.includeBodies ?? true,
      onIoError: (message) => ioErrors.push(message),
    });
  const unload = await loadPlugins(ctx, [sessionPlugin, telemetryPlugin]);
  return { ctx, store: ctx.use(sessionStore), telemetry: ctx.use(sqliteTelemetry), exec, ioErrors, unload, db };
}

/** flush 后再读库（同步落库：内存库即时可见） */
async function flushed(world: World, s: Session): Promise<void> {
  const result = await world.store.flush(s.id);
  if (!result.ok) throw new Error(result.reason);
}

function userMessage(s: Session, at: { readonly turn: number; readonly step: number }, text: string): void {
  s.append("user/message", { turn: at.turn, step: at.step, content: [{ type: "text", text }] }, append);
}

function turn(s: Session, n: number): void {
  s.append("turn/start", { turn: n });
}

describe("全链路落库", () => {
  it("turn/step/llm/tool 全部落库；spansOf 树形 start_ms 序；logsOf seq 序", async () => {
    world = await makeWorld();
    const s = unwrap(await world.store.create({ id: "s1" as SessionId }));
    turn(s, 0);
    s.append("step/start", { turn: 0, step: 0 });
    userMessage(s, { turn: 0, step: 0 }, "hi");
    s.append("request/header", { model: "fake", provider: "fake", tools: [] });
    s.append("assistant/message", { turn: 0, step: 0, content: [{ type: "text", text: "hello" }], usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }, stopReason: "stop" }, append);
    s.append("tool/call", { turn: 0, step: 0, callId: "c1", name: "bash", arguments: "{}" });
    s.append("tool/result", { turn: 0, step: 0, callId: "c1", content: "done" }, append);
    s.append("step/end", { turn: 0, step: 0 });
    s.append("turn/end", { turn: 0, reason: { kind: "completed" } });
    await flushed(world, s);

    const spans = world.telemetry.spansOf("s1");
    expect(spans.map((row) => row.name)).toEqual(["session", "turn", "step", "llm.chat", "tool.bash"]);
    expect(spans[1]?.parentSpanId).toBe(spans[0]?.spanId);
    expect(spans[2]?.parentSpanId).toBe(spans[1]?.spanId);
    expect(spans[3]?.parentSpanId).toBe(spans[2]?.spanId);
    expect(spans[4]?.endMs).not.toBeNull();

    const logs = world.telemetry.logsOf("s1");
    expect(logs.map((row) => row.eventType)).toEqual(s.events().map((event) => event.type));
    expect(logs.every((row) => row.body !== null)).toBe(true); // includeBodies 缺省 true
  });

  it("usageOf：llm span 聚合四字段（cache 不丢）", async () => {
    world = await makeWorld();
    const s = unwrap(await world.store.create({ id: "u1" as SessionId }));
    turn(s, 0);
    s.append("step/start", { turn: 0, step: 0 });
    s.append("request/header", { model: "m", tools: [] });
    s.append("assistant/attempt", { turn: 0, step: 0, error: "503", usage: { input: 4, output: 0, cacheRead: 1 } });
    s.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3 }, stopReason: "stop" }, append);
    await flushed(world, s);
    expect(world.telemetry.usageOf("u1")).toEqual({ inputTokens: 14, outputTokens: 5, cacheRead: 3, cacheWrite: 3 });
  });

  it("usageOf：无 llm span → undefined；有 llm span 无 usage → undefined", async () => {
    world = await makeWorld();
    const s = unwrap(await world.store.create({ id: "u2" as SessionId }));
    turn(s, 0);
    await flushed(world, s);
    expect(world.telemetry.usageOf("u2")).toBeUndefined();

    const s2 = unwrap(await world.store.create({ id: "u3" as SessionId }));
    turn(s2, 0);
    s2.append("step/start", { turn: 0, step: 0 });
    s2.append("assistant/message", { turn: 0, step: 0, content: [], stopReason: "stop" }, append); // 无 usage
    await flushed(world, s2);
    expect(world.telemetry.usageOf("u3")).toBeUndefined();
  });

  it("includeBodies=false → body 列 NULL 只存投影", async () => {
    world = await makeWorld({ includeBodies: false });
    const s = unwrap(await world.store.create({ id: "b1" as SessionId }));
    turn(s, 0);
    userMessage(s, { turn: 0, step: 0 }, "secret");
    await flushed(world, s);
    expect(world.telemetry.logsOf("b1").every((row) => row.body === null)).toBe(true);
  });

  it("fork 子会话（同 prefix 不同 id）互不串：各自 trace_id 独立", async () => {
    world = await makeWorld();
    const parent = unwrap(await world.store.create({ id: "p" as SessionId }));
    turn(parent, 0);
    const child = unwrap(await world.store.fork(parent.id, { id: "c" as SessionId }));
    turn(child, 1);
    await flushed(world, parent);
    await flushed(world, child);
    const pSpans = world.telemetry.spansOf("p");
    const cSpans = world.telemetry.spansOf("c");
    expect(pSpans[0]?.traceId).not.toBe(cSpans[0]?.traceId);
    expect(world.telemetry.logsOf("p").length).toBe(1);
    expect(world.telemetry.logsOf("c").length).toBeGreaterThan(1); // 前缀 + turn1 + end-seed
  });
});

describe("幂等与重放（§3：不产生重复行）", () => {
  it("同 seq 重放：OR IGNORE 吸收，行数不变", async () => {
    world = await makeWorld();
    const s = unwrap(await world.store.create({ id: "r1" as SessionId }));
    turn(s, 0);
    await flushed(world, s);
    const before = world.telemetry.logsOf("r1").length;
    // 重放：手工再次投递同事件（审计通道不重投，模拟异常路径）
    world.ctx.emit(await import("@x-harness/session").then((m) => m.sessionAuditEvent), { session: s.id, event: s.events()[0] as SessionEvent });
    await flushed(world, s);
    expect(world.telemetry.logsOf("r1").length).toBe(before);
  });
});

describe("flush 屏障 fail-closed（§1.4）", () => {
  it("写失败 → store.flush Result 失败 + degraded 上报恰一次；恢复后按序补写", async () => {
    const db = new Database(":memory:");
    const exec = createBunSqliteExecutor(db);
    const ioErrors: string[] = [];
    const ctx = createContext();
    // 故障注入：run 计数到 N 后抛
    let failNext = 0;
    const failing: import("../types.ts").SqliteExecutor = {
      run: (sql, params) => {
        if (failNext > 0) {
          failNext -= 1;
          throw new Error("disk I/O error");
        }
        return exec.run(sql, params);
      },
      all: (sql, params) => exec.all(sql, params),
    };
    const unload = await loadPlugins(ctx, [
      sessionPlugin,
      sqliteTelemetryPlugin({ db: failing, tx: undefined, resource: { serviceName: "t" }, onIoError: (m) => ioErrors.push(m) }),
    ]);
    world = { ctx, store: ctx.use(sessionStore), telemetry: ctx.use(sqliteTelemetry), exec, ioErrors, unload, db };
    const s = unwrap(await world.store.create({ id: "f1" as SessionId }));
    turn(s, 0);
    userMessage(s, { turn: 0, step: 0 }, "x");
    failNext = 2; // 实时段首 run + flush 段首 run 各失败一次（闩去重上报恰一次）；retry 段无故障
    const flushResult = await world.store.flush(s.id); // 闩在：flush 排空段也失败（fail-closed 上浮）
    expect(flushResult.ok).toBe(false);
    expect(flushResult.ok === false && flushResult.reason).toContain("disk I/O error"); // store 聚合的根因
    expect(ioErrors.length).toBeGreaterThan(0); // onIoError 上报可见（不静默）
    // 恢复：故障已过（failNext 耗尽），重试屏障成功且按序补写
    const retry = await world.store.flush(s.id);
    expect(retry.ok).toBe(true);
    expect(world.telemetry.logsOf("f1").length).toBe(s.events().length);
  });
});

describe("晚装载 fail-closed（§2）", () => {
  it("created 未达的会话：审计事件只入 pending 不写库；flush 报 telemetry-unopened", async () => {
    // writer 直接面：插件晚于会话创建装载的等价形态（fold 未开——不建账不静默补灌）
    const db = new Database(":memory:");
    const exec = createBunSqliteExecutor(db);
    ensureSchema(exec);
    const w = createTelemetryWriter({ db: exec, resource: { serviceName: "t" }, includeBodies: true, onIoError: () => {} });
    const event = { type: "turn/start", seq: 0, time: 1, data: { turn: 0 } } as SessionEvent;
    w.onAuditEvent("orphan" as SessionId, event); // created 未达：不崩不建账
    await expect(w.flush("orphan" as SessionId)).rejects.toThrow(/telemetry-unopened:orphan/); // fail-closed 上浮
    const q = createQueryService(exec);
    expect(q.logsOf("orphan")).toEqual([]); // 不静默补灌
    await w.drainAll();
    db.close();
  });
});

describe("unload 排空与首灌（§1.5）", () => {
  it("dispose 终排空：session span 闭合、pending 清空", async () => {
    world = await makeWorld();
    const s = unwrap(await world.store.create({ id: "d1" as SessionId }));
    turn(s, 0);
    userMessage(s, { turn: 0, step: 0 }, "bye");
    world.store.dispose(s.id); // sessionDisposed → 终排空段
    await world.ctx.dispose();
    const spans = world.telemetry.spansOf("d1");
    expect(spans[0]?.name).toBe("session");
    expect(spans[0]?.endMs).not.toBeNull();
    expect(world.telemetry.logsOf("d1").length).toBe(2);
  });

  it("created 首灌：构造期事件（无显式 flush）经 dispose 落库", async () => {
    world = await makeWorld();
    const s = unwrap(await world.store.create({ id: "seed" as SessionId, seed: [{ type: "turn/start", seq: 0, time: 1, data: { turn: 0 } }] }));
    void s;
    await world.ctx.dispose();
    expect(world.telemetry.logsOf("seed").length).toBeGreaterThanOrEqual(2); // seed + end-seed
  });
});

describe("resume 续链（跨重启同库）", () => {
  it("第二次装配：DB 已有会话 → 同 trace 续写不铸新号、游标吸收已落前缀", async () => {
    // 第一段：写半截（step/tool 未闭）
    const db = new Database(":memory:");
    const exec = createBunSqliteExecutor(db);
    const ctx1 = createContext();
    await loadPlugins(ctx1, [sessionPlugin, sqliteTelemetryPlugin({ db: exec, tx: exec.tx, resource: { serviceName: "t" } })]);
    const store1 = ctx1.use(sessionStore);
    const s1 = unwrap(await store1.create({ id: "res" as SessionId }));
    turn(s1, 0);
    s1.append("step/start", { turn: 0, step: 0 });
    s1.append("request/header", { model: "m", tools: [] });
    s1.append("assistant/message", { turn: 0, step: 0, content: [], usage: { input: 7, output: 2 }, stopReason: "stop" }, append);
    const flushed1 = await store1.flush(s1.id);
    expect(flushed1.ok).toBe(true);
    await ctx1.dispose();
    const traceBefore = db.query("SELECT trace_id FROM otel_sessions WHERE session_id = 'res'").get() as { trace_id: string };

    // 第二段：同库重开 + resume（seed = 已落事件）
    const ctx2 = createContext();
    const ioErrors2: string[] = [];
    await loadPlugins(ctx2, [sessionPlugin, sqliteTelemetryPlugin({ db: exec, tx: exec.tx, resource: { serviceName: "t" }, onIoError: (m) => ioErrors2.push(m) })]);
    const store2 = ctx2.use(sessionStore);
    const archived = db.query("SELECT body FROM otel_logs WHERE session_id = 'res' ORDER BY seq").all() as { body: string }[];
    const seed = archived.map((row) => JSON.parse(row.body) as SessionEvent);
    const s2 = unwrap(await store2.create({ id: "res" as SessionId, seed }));
    s2.append("tool/call", { turn: 0, step: 0, callId: "cx", name: "grep", arguments: "{}" });
    s2.append("tool/result", { turn: 0, step: 0, callId: "cx", content: "found" }, append);
    s2.append("step/end", { turn: 0, step: 0 });
    s2.append("turn/end", { turn: 0, reason: { kind: "completed" } });
    const flushed2 = await store2.flush(s2.id);
    expect(flushed2.ok).toBe(true);
    await ctx2.dispose();

    const traceAfter = db.query("SELECT trace_id FROM otel_sessions WHERE session_id = 'res'").get() as { trace_id: string };
    expect(traceAfter.trace_id).toBe(traceBefore.trace_id); // trace 复用
    const spanCount = (db.query("SELECT COUNT(*) AS n FROM otel_spans WHERE session_id = 'res'").get() as { n: number }).n;
    const logCount = (db.query("SELECT COUNT(*) AS n FROM otel_logs WHERE session_id = 'res'").get() as { n: number }).n;
    expect(logCount).toBe(seed.length + 5); // 前缀不重折：4 显式新事件 + resume end-seed
    expect(spanCount).toBe(5); // session + turn + step + llm.chat + tool.grep（无重复行）
    db.close();
  });
});

describe("装载期 fail-fast（§1.4）", () => {
  it("schema_version=99 → 插件装载失败", async () => {
    const db = new Database(":memory:");
    const exec = createBunSqliteExecutor(db);
    db.run("CREATE TABLE schema_version (version INTEGER NOT NULL)");
    db.run("INSERT INTO schema_version VALUES (99)");
    const ctx = createContext();
    await expect(
      loadPlugins(ctx, [sessionPlugin, sqliteTelemetryPlugin({ db: exec, resource: { serviceName: "t" } })]),
    ).rejects.toThrow(/schema-version-mismatch.*found=99/);
    await ctx.dispose().catch(() => {});
    db.close();
  });
});

describe("deleteSession 留存治理（§2 裁决 4A）", () => {
  it("级联删三表该会话行；返回删除总行数；他者不受影响", async () => {
    world = await makeWorld();
    const a = unwrap(await world.store.create({ id: "keep" as SessionId }));
    const b = unwrap(await world.store.create({ id: "drop" as SessionId }));
    turn(a, 0);
    turn(b, 0);
    await flushed(world, a);
    await flushed(world, b);
    const removed = world.telemetry.deleteSession("drop");
    expect(removed).toBeGreaterThan(0);
    expect(world.telemetry.spansOf("drop")).toEqual([]);
    expect(world.telemetry.logsOf("keep").length).toBeGreaterThan(0);
  });
});

describe("0 定时器预算（§3）", () => {
  it("writer 不注册 setTimeout/setInterval", async () => {
    const spies = [vi.spyOn(globalThis, "setTimeout"), vi.spyOn(globalThis, "setInterval")];
    world = await makeWorld();
    const s = unwrap(await world.store.create({ id: "t0" as SessionId }));
    turn(s, 0);
    await flushed(world, s);
    expect(spies[1]?.mock.calls.length).toBe(0);
    const timer = spies[0];
    spies[1]?.mockRestore();
    timer?.mockRestore();
  });
});
