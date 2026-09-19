// 插件装配测试（docs/TASKS.md §2）：provide hub + 双工具注册/并发声明 + 摘除回卷 +
// bashTasks 在场的端到端接缝（真登记簿句柄 → task_output/task_stop）。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { sessionPlugin } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { createLocalEnv } from "@x-harness/exec-env";
import { BackgroundTasks, defaultTaskLimits } from "@x-harness/tool-bash";
import type { BackgroundTasks as BackgroundTasksType } from "@x-harness/tool-bash";
import { createTaskToolsPlugin } from "../plugin.ts";
import { taskHub } from "../tokens.ts";

const sid = (v: string): SessionId => v as SessionId;
let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

async function assemble(bashTasks?: BackgroundTasksType) {
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, createTaskToolsPlugin(bashTasks !== undefined ? { bashTasks } : {})]);
  return { ctx, registry: ctx.use(toolRegistry), unload };
}

describe("task-tools plugin assembly", () => {
  it("provides the hub and registers exactly task_output/task_stop with declared concurrency", async () => {
    const { ctx, registry } = await assemble();
    expect(ctx.tryUse(taskHub)).toBeDefined();
    expect(registry.get("task_output")).toBeDefined();
    expect(registry.get("task_stop")).toBeDefined();
    expect(registry.schemas().map((schema) => schema.name).filter((name) => name.startsWith("task_"))).toEqual(["task_output", "task_stop"]);
    expect(registry.concurrencyOf("task_output", { task_id: "x" })).toBe("parallel");
    expect(registry.concurrencyOf("task_stop", { task_id: "x" })).toBe("exclusive");
    await ctx.dispose();
    expect(registry.get("task_output")).toBeUndefined(); // 摘除回卷
    expect(registry.get("task_stop")).toBeUndefined();
  });

  it("end-to-end bash seam: a registry-started task is read and stopped through the tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "xh-tasktools-"));
    roots = [...roots, root];
    const boxTasks = new BackgroundTasks(defaultTaskLimits({}, { maxOutputBytes: 30_000, spillDir: root }));
    const { ctx, registry } = await assemble(boxTasks);
    const session = sid("plugin-e2e");
    const started = await boxTasks.start({ command: "sleep 0.2; echo seam-marker", cwd: root, session, env: createLocalEnv(root) });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.reason);

    const read = await registry.dispatch({ callId: "c1", name: "task_output", args: { task_id: started.value.id }, signal: new AbortController().signal, session });
    expect(read.isError).toBeUndefined();
    expect(read.content).toContain("seam-marker");
    expect(read.content).toContain(`task ${started.value.id} (`);
    expect(read.content).toContain("completed exit=0");
    expect(read.content).toContain("more=false");

    const long = await boxTasks.start({ command: "sleep 30", cwd: root, session, env: createLocalEnv(root) });
    expect(long.ok).toBe(true);
    if (!long.ok) throw new Error(long.reason);
    const stopped = await registry.dispatch({ callId: "c2", name: "task_stop", args: { task_id: long.value.id }, signal: new AbortController().signal, session });
    expect(stopped.isError).toBeUndefined();
    expect(stopped.content).toContain("killed");
    expect(stopped.content).not.toContain("mid-kill"); // whenSettled 收敛后铸终态
    await ctx.dispose(); // dispose 两段杀在途任务
  });

  it("without bashTasks the hub answers unified not-found for bash-shaped ids", async () => {
    const { ctx, registry } = await assemble();
    const out = await registry.dispatch({ callId: "c1", name: "task_output", args: { task_id: "t-ab12cd34ef56" }, signal: new AbortController().signal, session: sid("s") });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("no such task in any source");
    await ctx.dispose();
  });
});
