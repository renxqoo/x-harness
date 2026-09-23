// 后台任务测试（docs/TOOLBOX.md §4/§6 + docs/TASK-PUSH-DESIGN.md §2.2/§4）：立返/状态机/
// 日志路径契约与双流落盘/写帽快照面/并发帽/墙钟帽/幂等停/会话隔离/sessionDisposed 与
// dispose 清场/onSettled 五路终态恰好一次与隔离/IO 拒启。模型侧停止动词（task_stop）与
// 完成推送（[task-notification]）归任务层——本套件经登记簿句柄直接验证其 bash 源语义。

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createLocalEnv } from "@x-harness/exec-env";
import { sessionPlugin } from "@x-harness/session";
import { PathGate } from "@x-harness/tool-core";
import { BackgroundTasks, defaultTaskLimits } from "../tasks.ts";
import type { BackgroundTasks as BackgroundTasksType, TaskSnapshot } from "../tasks.ts";
import type { ToolRegistry } from "@x-harness/tools";
import { createContext, loadPlugins } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";
import { createBashPlugin } from "../plugin.ts";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";

/** SessionId 品牌（测试会话名都是普通字符串） */
const sid = (v: string): SessionId => v as SessionId;

let root: string;
let registry: ToolRegistry;
let tasks: BackgroundTasksType;
let logRoot: string;
let disposers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "xh-task-"));
  logRoot = mkdtempSync(join(tmpdir(), "xh-task-logs-"));
  tasks = new BackgroundTasks(defaultTaskLimits({ taskTimeoutMs: 2_000, maxConcurrentTasks: 2, taskLogDir: logRoot }));
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, createBashPlugin({ gate: new PathGate(root), env: createLocalEnv(root), tasks })]);
  registry = ctx.use(toolRegistry);
  disposers.push(async () => {
    await ctx.dispose();
    void unload;
  });
});

afterEach(async () => {
  for (const fn of disposers) await fn().catch(() => {});
  disposers = [];
  rmSync(root, { recursive: true, force: true });
  rmSync(logRoot, { recursive: true, force: true });
});

let counter = 0;
const bash = (args: Record<string, unknown>, session?: string): Promise<{ content: string; isError?: true }> =>
  registry.dispatch({ callId: `t${String((counter += 1))}`, name: "bash", args, signal: new AbortController().signal, ...(session !== undefined ? { session: session as never } : {}) });

const idOf = (content: string): string => {
  const id = content.match(/Background task (t-[0-9a-f]+) started/)?.[1];
  if (id === undefined) throw new Error(`no task id in: ${content}`);
  return id;
};

const logPathOf = (content: string): string => {
  const path = content.match(/output appends to (\S+);/)?.[1];
  if (path === undefined) throw new Error(`no log path in: ${content}`);
  return path;
};

const snapOf = (book: BackgroundTasksType, session: SessionId, id: string): TaskSnapshot | undefined =>
  book.list(session).find((t) => t.id === id);

const waitUntil = async (probe: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("waitUntil timeout");
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
};

describe("后台任务（docs/TOOLBOX.md §4——登记簿即任务层的 bash 源）", () => {
  it("立返不等待：sleep 未完先拿到 id 与日志路径；随后完成态可查、日志全文在盘", async () => {
    const started = Date.now();
    const r = await bash({ command: "sleep 1; echo bg-done", run_in_background: true }, "s1");
    expect(r.isError).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(300); // 不等命令完成
    const id = idOf(r.content);
    const logPath = logPathOf(r.content);
    expect(logPath.startsWith(logRoot)).toBe(true); // 路径契约：<taskLogDir>/<sessionKey>/bash-task-<id>.log
    await waitUntil(() => snapOf(tasks, sid("s1"), id)?.state === "completed");
    const snap = snapOf(tasks, sid("s1"), id);
    expect(snap?.exitCode).toBe(0);
    expect(snap?.logPath).toBe(logPath);
    expect(readFileSync(logPath, "utf8")).toContain("bg-done"); // 读面 = 日志文件
  });

  it("日志路径契约：会话子目录 + 匿名桶 _anon", async () => {
    const r = await bash({ command: "true", run_in_background: true }, "s7");
    const id = idOf(r.content);
    const logPath = logPathOf(r.content);
    expect(logPath).toBe(join(logRoot, "s7", `bash-task-${id}.log`));
    await waitUntil(() => snapOf(tasks, sid("s7"), id)?.state === "completed");
    expect(existsSync(logPath)).toBe(true); // 文件随流打开落位（完成态必在盘）
    expect(existsSync(join(logRoot, "s7"))).toBe(true); // 目录先于 spawn 同步建
    const anon = new BackgroundTasks(defaultTaskLimits({ taskLogDir: logRoot }));
    const made = await anon.start({ command: "true", cwd: root, session: undefined, env: createLocalEnv(root) });
    expect(made.ok).toBe(true);
    if (made.ok) expect(made.value.logPath.startsWith(join(logRoot, "_anon"))).toBe(true);
  });

  it("状态机：非零退出 → failed（exitCode 可见）；信号死折算 128+n", async () => {
    const bad = idOf((await bash({ command: "sleep 0.1; exit 3", run_in_background: true }, "s1")).content);
    await waitUntil(() => snapOf(tasks, sid("s1"), bad)?.state === "failed");
    expect(snapOf(tasks, sid("s1"), bad)?.exitCode).toBe(3);
    const killed = idOf((await bash({ command: "sleep 0.1; kill -9 $$", run_in_background: true }, "s1")).content);
    await waitUntil(() => (snapOf(tasks, sid("s1"), killed)?.exitCode ?? null) !== null);
    expect(snapOf(tasks, sid("s1"), killed)?.exitCode).toBe(137); // 128+9
  });

  it("双流并流落盘：stdout/stderr 同窗到达，文件内双流 marker 齐备且同流保序", async () => {
    const r = await bash({ command: "printf 'o1'; printf 'e1' >&2; printf 'o2'; printf 'e2' >&2; printf 'o3'", run_in_background: true }, "s1");
    const id = idOf(r.content);
    const logPath = logPathOf(r.content);
    await waitUntil(() => snapOf(tasks, sid("s1"), id)?.state === "completed");
    const text = readFileSync(logPath, "utf8");
    for (const marker of ["o1", "e1", "o2", "e2", "o3"]) expect(text).toContain(marker);
    expect(text.indexOf("o1")).toBeLessThan(text.indexOf("o2")); // 同流（stdout）内保序
    expect(text.indexOf("o2")).toBeLessThan(text.indexOf("o3"));
    expect(text.indexOf("e1")).toBeLessThan(text.indexOf("e2")); // 同流（stderr）内保序
  });

  it("写帽快照面：超帽 → truncated + droppedBytes + 前缀保留（截断不撕裂多字节字符）", async () => {
    const small = new BackgroundTasks(defaultTaskLimits({ taskTimeoutMs: 5_000, fullCapBytes: 1_000, taskLogDir: logRoot }));
    const started = await small.start({ command: "seq 1 100000", cwd: root, session: sid("s1"), env: createLocalEnv(root) });
    if (!started.ok) throw new Error(started.reason);
    await waitUntil(() => snapOf(small, sid("s1"), started.value.id)?.state === "completed", 10_000);
    const snap = snapOf(small, sid("s1"), started.value.id);
    expect(snap?.truncated).toBe(true);
    expect(snap?.droppedBytes).toBeGreaterThan(0);
    expect(snap?.bytes).toBeLessThanOrEqual(1_000);
    const text = readFileSync(started.value.logPath, "utf8");
    expect(Buffer.byteLength(text)).toBe(snap?.bytes); // 快照 bytes = 文件实长
    expect(text.endsWith("\uFFFD")).toBe(false); // 截断点 UTF-8 边界——无替换符
  }, 15_000);

  it("日志拒启：taskLogDir 不可写（路径被文件占用）→ TASK_LOG_DIR_UNWRITABLE，零进程副作用", async () => {
    const blocked = join(root, "blocked-as-file");
    writeFileSync(blocked, "not a dir");
    const bad = new BackgroundTasks(defaultTaskLimits({ taskLogDir: join(blocked, "sub") }));
    const made = await bad.start({ command: "sleep 30", cwd: root, session: sid("s1"), env: createLocalEnv(root) });
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.reason).toContain("TASK_LOG_DIR_UNWRITABLE");
    expect(bad.list(sid("s1"))).toEqual([]); // 未登记（spawn 未发生）
  });

  it("stop 幂等：running → killed；终态再 stop 返回当前快照", async () => {
    const id = idOf((await bash({ command: "sleep 30", run_in_background: true }, "s1")).content);
    const stopped = tasks.stop(sid("s1"), id);
    expect(stopped.ok).toBe(true);
    if (stopped.ok) expect(stopped.value.state).toBe("killed");
    const again = tasks.stop(sid("s1"), id);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.state).toBe("killed");
    await waitUntil(() => snapOf(tasks, sid("s1"), id)?.endedAt !== undefined, 5_000); // 真死（finalize 产物）而非乐观态
    expect(snapOf(tasks, sid("s1"), id)?.state).toBe("killed");
  });

  it("墙钟帽：超时自动两段杀 → timed-out（marker 不出现）", async () => {
    const marker = join(root, "after-cap");
    // 存活期（12s）必须超过 帽(2s)+宽限(5s)——否则 TERM 免疫者自然跑完也会 touch
    const id = idOf((await bash({ command: `trap "" TERM; sleep 12; touch ${marker}`, run_in_background: true }, "s1")).content);
    await waitUntil(() => snapOf(tasks, sid("s1"), id)?.state === "timed-out", 8_000);
    await new Promise((resolve) => {
      setTimeout(resolve, 6_500);
    });
    expect(existsSync(marker)).toBe(false); // KILL 升级兜底——TERM 免疫的孙进程也被杀净
  }, 15_000);

  it("并发帽：每会话 2——第三个拒绝 TASK_LIMIT；完成后可再启", async () => {
    const a = await bash({ command: "sleep 1", run_in_background: true }, "s1");
    const b = await bash({ command: "sleep 1", run_in_background: true }, "s1");
    expect(a.isError).toBeUndefined();
    expect(b.isError).toBeUndefined();
    const capped = await bash({ command: "true", run_in_background: true }, "s1");
    expect(capped.isError).toBe(true);
    expect(capped.content).toContain("TASK_LIMIT");
    const other = await bash({ command: "true", run_in_background: true }, "s2"); // 会话键控：B 会话不受 A 影响
    expect(other.isError).toBeUndefined();
    await waitUntil(() => tasks.runningOf(sid("s1")) === 0, 4_000);
    const after = await bash({ command: "true", run_in_background: true }, "s1");
    expect(after.isError).toBeUndefined();
  });

  it("会话隔离：A 会话不可停 B 的任务，list 不可见异会话", async () => {
    const id = idOf((await bash({ command: "sleep 2", run_in_background: true }, "sA")).content);
    const stop = tasks.stop(sid("sB"), id);
    expect(stop.ok).toBe(false);
    if (!stop.ok) expect(stop.reason).toContain("TASK_NOT_FOUND");
    expect(tasks.list(sid("sB")).some((t) => t.id === id)).toBe(false);
    expect(snapOf(tasks, sid("sA"), id)?.state).toBe("running"); // 隔离拒绝不动 A 的任务
  });

  it("sessionDisposed：会话终结两段杀并清桶（断言先于 teardown——不靠 dispose 兜底）", async () => {
    const marker = join(root, "after-session-end");
    const ctx2 = createContext();
    const tasks2 = new BackgroundTasks(defaultTaskLimits({ taskLogDir: logRoot }));
    let unload2: (() => Promise<void>) | undefined;
    try {
      const unload = await loadPlugins(ctx2, [sessionPlugin, toolsPlugin, createBashPlugin({ gate: new PathGate(root), env: createLocalEnv(root), tasks: tasks2 })]);
      unload2 = async () => {
        await unload;
      };
      const reg2 = ctx2.use(toolRegistry);
      const made = await ctx2.use((await import("@x-harness/session")).sessionStore).create({ id: "sY" as never });
      if (!made.ok) throw new Error(made.reason);
      const r = await reg2.dispatch({ callId: "tx", name: "bash", args: { command: `sleep 6; touch ${marker}`, run_in_background: true }, signal: new AbortController().signal, session: "sY" as never });
      void idOf(r.content);
      const disposed = ctx2.use((await import("@x-harness/session")).sessionStore).dispose("sY" as never); // → sessionDisposed → evict：两段杀 + 清桶
      expect(disposed.ok).toBe(true);
      expect(tasks2.list(sid("sY") as never)).toEqual([]); // 清桶——会话生命周期即登记生命周期
      await new Promise((resolve) => {
        setTimeout(resolve, 6_500);
      });
      expect(existsSync(marker)).toBe(false); // 杀净证据在 teardown 之前取得（回归：曾靠 dispose 兜底假绿）
    } finally {
      await unload2?.().catch(() => {});
      await ctx2.dispose();
    }
  }, 15_000);

  it("dispose 清场：装配拆卸直接 KILL 全部（marker 不出现、无孤儿）", async () => {
    const marker = join(root, "after-dispose");
    const id = idOf((await bash({ command: `sleep 6; touch ${marker}`, run_in_background: true }, "s1")).content);
    void id;
    for (const fn of disposers) await fn().catch(() => {});
    disposers = []; // 已手动拆卸——afterEach 不再重复
    await new Promise((resolve) => {
      setTimeout(resolve, 6_500);
    });
    expect(existsSync(marker)).toBe(false);
    expect(tasks.list(sid("s1")).every((t) => t.state !== "running")).toBe(true);
  }, 15_000);

  it("并发帽 TOCTOU 回归：同会话并发双 start（帽=1）恰一成功——mkdir/spawn 的 await 窗口由占位封死", async () => {
    const solo = new BackgroundTasks(defaultTaskLimits({ maxConcurrentTasks: 1, taskTimeoutMs: 30_000, taskLogDir: logRoot }));
    const session = sid("s-race");
    const env = createLocalEnv(root);
    const [a, b] = await Promise.all([
      solo.start({ command: "sleep 0.3", cwd: root, session, env }),
      solo.start({ command: "sleep 0.3", cwd: root, session, env }),
    ]);
    const outcomes = [a.ok, b.ok].sort();
    expect(outcomes).toEqual([false, true]); // 恰一成功——占位先于一切 await
    if (!a.ok) expect(a.reason).toContain("TASK_LIMIT");
    if (!b.ok) expect(b.ok === false ? b.reason : "").toContain("TASK_LIMIT");
    await waitUntil(() => solo.runningOf(session) === 0, 4_000);
  });

  it("词表外 session id（路径穿越面）：start 入口拒（不托底给调用方）", async () => {
    const made = await tasks.start({ command: "true", cwd: root, session: "../escape" as never, env: createLocalEnv(root) });
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.reason).toContain("INVALID_SESSION");
    expect(tasks.list(undefined)).toEqual([]); // 未登记未落目录
  });

  it("spawn 失败透传 SPAWN_FAILED", async () => {
    const badEnv = {
      root,
      spawn: async () => ({ ok: false as const, reason: { kind: "denied", detail: "test" } }),
    } as never;
    const r = await tasks.start({ command: "true", cwd: root, session: sid("s1"), env: badEnv });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("SPAWN_FAILED");
  });
});

describe("onSettled 终态订阅（finalize 单点恰好一次）", () => {
  it("自然完成：恰好一次发射；订阅者读文件无撕裂尾（快照 bytes = 文件实长）", async () => {
    const seen: TaskSnapshot[] = [];
    const off = tasks.onSettled((snap) => seen.push(snap));
    const r = await bash({ command: "printf 'full-output-marker'", run_in_background: true }, "s1");
    await waitUntil(() => seen.length > 0);
    off();
    expect(seen.length).toBe(1); // 恰好一次
    const snap = seen[0];
    if (snap === undefined) throw new Error("no snapshot");
    expect(snap.state).toBe("completed");
    expect(snap.session).toBe(sid("s1")); // 路由键在场
    expect(snap.logPath).toBe(logPathOf(r.content));
    expect(readFileSync(snap.logPath, "utf8")).toBe("full-output-marker"); // 发射时已全部落盘
    expect(statSync(snap.logPath).size).toBe(snap.bytes);
  });

  it("stop 两段杀：killed 恰好一次发射", async () => {
    const seen: TaskSnapshot[] = [];
    tasks.onSettled((snap) => seen.push(snap));
    const id = idOf((await bash({ command: "sleep 30", run_in_background: true }, "s1")).content);
    tasks.stop(sid("s1"), id);
    await waitUntil(() => seen.length > 0, 8_000);
    expect(seen.length).toBe(1);
    expect(seen[0]?.state).toBe("killed");
    expect(seen[0]?.session).toBe(sid("s1"));
  });

  it("墙钟超时：timed-out 恰好一次发射", async () => {
    const seen: TaskSnapshot[] = [];
    tasks.onSettled((snap) => seen.push(snap));
    const id = idOf((await bash({ command: "sleep 30", run_in_background: true }, "s1")).content);
    void id;
    await waitUntil(() => seen.length > 0, 8_000);
    expect(seen.length).toBe(1);
    expect(seen[0]?.state).toBe("timed-out");
  }, 10_000);

  it("evict 清桶后 finalize 仍发射（killed——订阅先于清桶挂载）", async () => {
    const seen: TaskSnapshot[] = [];
    tasks.onSettled((snap) => seen.push(snap));
    await bash({ command: "sleep 30", run_in_background: true }, "sE");
    tasks.evict(sid("sE"));
    await waitUntil(() => seen.length > 0, 8_000);
    expect(seen.length).toBe(1);
    expect(seen[0]?.state).toBe("killed");
  }, 10_000);

  it("非零退出 → failed 恰好一次发射", async () => {
    const seen: TaskSnapshot[] = [];
    tasks.onSettled((snap) => seen.push(snap));
    const id = idOf((await bash({ command: "sleep 0.1; exit 7", run_in_background: true }, "s1")).content);
    await waitUntil(() => seen.length > 0);
    expect(seen.length).toBe(1);
    expect(seen[0]?.state).toBe("failed");
    expect(seen[0]?.exitCode).toBe(7);
    void id;
  });

  it("兜底链：proc.exited reject（env 异常形态）→ 仍 finalize 恰好一次（快照可查、不卡 running）", async () => {
    const seen: TaskSnapshot[] = [];
    tasks.onSettled((snap) => seen.push(snap));
    const empty = new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    const boomEnv = {
      root,
      spawn: async () => ({
        ok: true as const,
        proc: {
          stdout: empty,
          stderr: empty,
          exited: Promise.reject(new Error("env-boom")),
          settled: Promise.resolve(),
          kill: () => {},
        },
      }),
    } as never;
    const made = await tasks.start({ command: "true", cwd: root, session: sid("s-boom"), env: boomEnv });
    expect(made.ok).toBe(true);
    await waitUntil(() => seen.length > 0, 5_000);
    expect(seen.length).toBe(1); // 兜底链 finalize(null,null)——不因 close/settle 异常静默跳过
    const snap = tasks.list(sid("s-boom")).find((t) => t.id === (made.ok ? made.value.id : ""));
    expect(snap?.endedAt).toBeDefined(); // 不卡 running
  });

  it("退订后不再发射", async () => {
    const seen: TaskSnapshot[] = [];
    const off = tasks.onSettled((snap) => seen.push(snap));
    off();
    const r = await bash({ command: "true", run_in_background: true }, "s1");
    await waitUntil(() => snapOf(tasks, sid("s1"), idOf(r.content))?.state === "completed");
    expect(seen).toEqual([]);
  });

  it("listener 同步 throw 不打穿其余 listener（per-listener 隔离）", async () => {
    const good: TaskSnapshot[] = [];
    const boom = (): never => {
      throw new Error("listener-bug");
    };
    tasks.onSettled(boom);
    tasks.onSettled((snap) => good.push(snap));
    await bash({ command: "true", run_in_background: true }, "s1");
    await waitUntil(() => good.length > 0);
    expect(good.length).toBe(1); // 首 listener 的 bug 未吞掉后续
  });
});
