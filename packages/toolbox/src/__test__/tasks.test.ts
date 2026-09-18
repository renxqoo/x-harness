// 后台任务测试（docs/TOOLBOX.md §4/§6）：立返/状态机五态/增量读/并发帽/墙钟帽/幂等停/
// 会话隔离/sessionDisposed 与 dispose 清场。模型侧读停动词（task_output/task_stop）归未来
// 任务层——本套件经登记簿句柄直接验证其 bash 源语义。

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createLocalEnv } from "@x-harness/exec-env";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import { createToolbox } from "../toolbox.ts";
import { BackgroundTasks, defaultTaskLimits } from "../tasks.ts";
import type { BackgroundTasks as BackgroundTasksType } from "../tasks.ts";
import type { ToolRegistry } from "@x-harness/tools";
import { createContext, loadPlugins } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";

/** SessionId 品牌（测试会话名都是普通字符串） */
const sid = (v: string): SessionId => v as SessionId;
import { toolsPlugin, toolRegistry } from "@x-harness/tools";

let root: string;
let registry: ToolRegistry;
let tasks: BackgroundTasksType;
let disposers: Array<() => Promise<void>> = [];
let spillDir: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "xh-task-"));
  spillDir = mkdtempSync(join(tmpdir(), "xh-task-spill-"));
  const box = createToolbox({ root, spillDir, taskTimeoutMs: 2_000, maxConcurrentTasks: 2, env: createLocalEnv(root) });
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, box.bashPlugin]);
  registry = ctx.use(toolRegistry);
  tasks = box.tasks;
  disposers.push(async () => {
    await ctx.dispose();
    void unload;
  });
});

afterEach(async () => {
  for (const fn of disposers) await fn().catch(() => {});
  disposers = [];
  rmSync(root, { recursive: true, force: true });
  rmSync(spillDir, { recursive: true, force: true });
});

let counter = 0;
const bash = (args: Record<string, unknown>, session?: string): Promise<{ content: string; isError?: true }> =>
  registry.dispatch({ callId: `t${String((counter += 1))}`, name: "bash", args, signal: new AbortController().signal, ...(session !== undefined ? { session: session as never } : {}) });

const idOf = (content: string): string => {
  const id = content.match(/Background task (t-[0-9a-f]+) started/)?.[1];
  if (id === undefined) throw new Error(`no task id in: ${content}`);
  return id;
};

const stateOf = (registry2: BackgroundTasksType, session: SessionId, id: string): string | undefined =>
  registry2.list(session).find((t) => t.id === id)?.state;

const exitCodeOf = (registry2: BackgroundTasksType, session: SessionId, id: string): number | null | undefined =>
  registry2.list(session).find((t) => t.id === id)?.exitCode;

const waitUntil = async (probe: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("waitUntil timeout");
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
};

describe("后台任务（docs/TOOLBOX.md §4——登记簿即 task 动词的 bash 源）", () => {
  it("立返不等待：sleep 未完先拿到 id；随后完成态与输出可读", async () => {
    const started = Date.now();
    const r = await bash({ command: "sleep 1; echo bg-done", run_in_background: true }, "s1");
    expect(r.isError).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(300); // 不等命令完成
    const id = idOf(r.content);
    expect(tasks.read(sid("s1"), id, 0).ok).toBe(true);
    await waitUntil(() => stateOf(tasks, sid("s1"), id) === "completed");
    const done = tasks.read(sid("s1"), id, 0);
    if (!done.ok) throw new Error(done.reason);
    expect(done.value.snapshot.state).toBe("completed");
    expect(done.value.snapshot.exitCode).toBe(0);
    expect(done.value.text).toContain("bg-done");
    expect(done.value.more).toBe(false);
  });

  it("状态机：非零退出 → failed（exitCode 可见）；信号死折算 128+n", async () => {
    const bad = idOf((await bash({ command: "sleep 0.1; exit 3", run_in_background: true }, "s1")).content);
    await waitUntil(() => stateOf(tasks, sid("s1"), bad) === "failed");
    const snap = tasks.list(sid("s1")).find((t) => t.id === bad);
    expect(snap?.exitCode).toBe(3);
    const killed = idOf((await bash({ command: "sleep 0.1; kill -9 $$", run_in_background: true }, "s1")).content);
    await waitUntil(() => (exitCodeOf(tasks, sid("s1"), killed) ?? null) !== null);
    expect(tasks.list(sid("s1")).find((t) => t.id === killed)?.exitCode).toBe(137); // 128+9
  });

  it("增量读：字节偏移切片 + 多字节字符边界；more 置位直到读完", async () => {
    const id = idOf((await bash({ command: "printf '€α€尾'; sleep 0.2; printf 'tail-end'", run_in_background: true }, "s1")).content);
    await waitUntil(() => stateOf(tasks, sid("s1"), id) === "completed");
    const r1 = tasks.read(sid("s1"), id, 0);
    if (!r1.ok) throw new Error(r1.reason);
    expect(r1.value.text).toBe("€α€尾tail-end");
    const r2 = tasks.read(sid("s1"), id, 3); // € 占 3 字节——恰在字符边界
    if (!r2.ok) throw new Error(r2.reason);
    expect(r2.value.text).toBe("α€尾tail-end");
    const r3 = tasks.read(sid("s1"), id, 4); // 伪 offset 落在 α（2 字节）中间——回退到字符首字节，不跳过数据
    if (!r3.ok) throw new Error(r3.reason);
    expect(r3.value.text).toBe("α€尾tail-end");
    const past = tasks.read(sid("s1"), id, 1_000_000); // 越界 offset 钳到 EOF
    if (!past.ok) throw new Error(past.reason);
    expect(past.value.text).toBe("");
    expect(past.value.more).toBe(false);
  });

  it("增量读分窗：more 置位 + nextOffset 续读（大输出分多次读完）", async () => {
    writeFileSync(join(root, "big.txt"), `${"x".repeat(29_000)}A\n${"y".repeat(29_000)}B\n`);
    const id = idOf((await bash({ command: "cat big.txt", run_in_background: true }, "s1")).content);
    await waitUntil(() => stateOf(tasks, sid("s1"), id) === "completed");
    let offset = 0;
    let chunks = 0;
    let tail = "";
    let firstWindowBytes: number | undefined;
    for (;;) {
      const r = tasks.read(sid("s1"), id, offset);
      if (!r.ok) throw new Error(r.reason);
      chunks += 1;
      if (firstWindowBytes === undefined) firstWindowBytes = r.value.nextOffset;
      tail = r.value.text;
      offset = r.value.nextOffset;
      if (!r.value.more) break;
    }
    expect(chunks).toBeGreaterThanOrEqual(2); // 58KB+ 超单窗
    expect(firstWindowBytes).toBeLessThanOrEqual(30_000); // 首窗 ≤ 展示帽（窗宽口径钉死）
    expect(tail.endsWith("B\n")).toBe(true);
  });

  it("stop 幂等：running → killed；终态再 stop 返回当前快照", async () => {
    const id = idOf((await bash({ command: "sleep 30", run_in_background: true }, "s1")).content);
    const stopped = tasks.stop(sid("s1"), id);
    expect(stopped.ok).toBe(true);
    if (stopped.ok) expect(stopped.value.state).toBe("killed");
    const again = tasks.stop(sid("s1"), id);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.state).toBe("killed");
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    const snap = tasks.list(sid("s1")).find((t) => t.id === id);
    expect(snap?.state).toBe("killed");
  });

  it("墙钟帽：超时自动两段杀 → timed-out（marker 不出现）", async () => {
    const marker = join(root, "after-cap");
    // 存活期（12s）必须超过 帽(2s)+宽限(5s)——否则 TERM 免疫者自然跑完也会 touch
    const id = idOf((await bash({ command: `trap "" TERM; sleep 12; touch ${marker}`, run_in_background: true }, "s1")).content);
    await waitUntil(() => stateOf(tasks, sid("s1"), id) === "timed-out", 8_000);
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

  it("会话隔离：A 会话不可读/停 B 的任务", async () => {
    const id = idOf((await bash({ command: "sleep 2", run_in_background: true }, "sA")).content);
    const read = tasks.read(sid("sB"), id, 0);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("TASK_NOT_FOUND");
    const stop = tasks.stop(sid("sB"), id);
    expect(stop.ok).toBe(false);
    expect(tasks.list(sid("sB")).some((t) => t.id === id)).toBe(false); // list 不可见异会话任务
    expect(tasks.list(sid("sA")).find((t) => t.id === id)?.state).toBe("running"); // 隔离拒绝不动 A 的任务
  });

  it("sessionDisposed：会话终结两段杀并清桶（断言先于 teardown——不靠 dispose 兜底）", async () => {
    const marker = join(root, "after-session-end");
    const ctx2 = createContext();
    const box2 = createToolbox({ root, spillDir, env: createLocalEnv(root) });
    let unload2: (() => Promise<void>) | undefined;
    try {
      const unload = await loadPlugins(ctx2, [sessionPlugin, toolsPlugin, box2.bashPlugin]);
      unload2 = async () => {
        await unload;
      };
      const reg2 = ctx2.use(toolRegistry);
      const made = await ctx2.use(sessionStore).create({ id: "sY" as never });
      if (!made.ok) throw new Error(made.reason);
      const r = await reg2.dispatch({ callId: "tx", name: "bash", args: { command: `sleep 6; touch ${marker}`, run_in_background: true }, signal: new AbortController().signal, session: "sY" as never });
      const id2 = idOf(r.content);
      const disposed = ctx2.use(sessionStore).dispose("sY" as never); // → sessionDisposed → evict：两段杀 + 清桶
      expect(disposed.ok).toBe(true);
      expect(box2.tasks.list(sid("sY") as never)).toEqual([]); // 清桶——会话生命周期即登记生命周期
      await new Promise((resolve) => {
        setTimeout(resolve, 6_500);
      });
      expect(existsSync(marker)).toBe(false); // 杀净证据在 teardown 之前取得（回归：曾靠 dispose 兜底假绿）
      void id2;
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

  it("保留帽 spill（回归：曾为永不触发的死路径）：超帽停累积 + 终态 spill 已保留部分", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xh-task-spill2-"));
    const small = new BackgroundTasks(defaultTaskLimits({ taskTimeoutMs: 5_000, fullCapBytes: 1_000 }, { maxOutputBytes: 30_000, spillDir: dir }));
    const started = await small.start({ command: "seq 1 100000", cwd: root, session: sid("s1"), env: createLocalEnv(root) });
    if (!started.ok) throw new Error(started.reason);
    await waitUntil(() => stateOf(small, sid("s1"), started.value.id) === "completed", 8_000);
    const read = small.read(sid("s1"), started.value.id, 0);
    if (!read.ok) throw new Error(read.reason);
    expect(read.value.snapshot.truncated).toBe(true); // 保留帽触达（fullCapped 口径）
    expect(read.value.snapshot.spillPath).toBeDefined(); // spill 落盘——恢复面在场
    expect(read.value.snapshot.bytes).toBeLessThanOrEqual(2_000); // 帽后计数与保留体对齐
    const spilled = read.value.snapshot.spillPath;
    if (spilled !== undefined) expect(readFileSync(spilled, "utf8").length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

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
