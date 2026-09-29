import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { sessionPlugin } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { createLocalEnv, createLocalEnvPlugin } from "@x-harness/exec-env";
import { backgroundTasks, createBashPlugin, BackgroundTasks, defaultTaskLimits } from "@x-harness/tool-bash";
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
  it("provides the hub and registers exactly task_stop with the exclusive concurrency declaration", async () => {
    const { ctx, registry } = await assemble();
    expect(ctx.tryUse(taskHub)).toBeDefined();
    expect(registry.get("task_stop")).toBeDefined();
    expect(registry.schemas().map((schema) => schema.name).filter((name) => name.startsWith("task_"))).toEqual(["task_stop"]);
    expect(registry.concurrencyOf("task_stop", { task_id: "x" })).toBe("exclusive");
    await ctx.dispose();
    expect(registry.get("task_stop")).toBeUndefined();
  });

  it("end-to-end bash seam: a registry-started task is stopped through the tool", async () => {
    const root = mkdtempSync(join(tmpdir(), "xh-tasktools-"));
    roots = [...roots, root];
    const boxTasks = new BackgroundTasks(defaultTaskLimits({ taskLogDir: root }));
    const { ctx, registry } = await assemble(boxTasks);
    const session = sid("plugin-e2e");
    const long = await boxTasks.start({ command: "sleep 30", cwd: root, session, env: createLocalEnv(root) });
    expect(long.ok).toBe(true);
    if (!long.ok) throw new Error(long.reason);
    const stopped = await registry.dispatch({ callId: "c1", name: "task_stop", args: { task_id: long.value.id }, signal: new AbortController().signal, session });
    expect(stopped.isError).toBeUndefined();
    expect(stopped.content).toContain("killed");
    expect(stopped.content).not.toContain("mid-kill");
    await ctx.dispose();
  });

  it("bare assembly docks tool-bash's registry via the service (no manual threading)", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, createLocalEnvPlugin(), createBashPlugin(), createTaskToolsPlugin()]);
    const session = sid("dock");
    const started = await ctx.use(backgroundTasks).start({ command: "echo dock-ok", cwd: process.cwd(), session, env: createLocalEnv(process.cwd()) });
    expect(started.ok).toBe(true);
    const tasks = ctx.use(backgroundTasks);
    const id = started.ok ? started.value.id : "";
    const deadline = Date.now() + 5_000;
    while ((tasks.list(session).find((t) => t.id === id)?.endedAt) === undefined && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    const stopped = await ctx.use(toolRegistry).dispatch({ callId: "c1", name: "task_stop", args: { task_id: id }, signal: new AbortController().signal, session });
    expect(stopped.isError).toBeUndefined();
    expect(stopped.content).toContain("already finished");
    await ctx.dispose();
    void unload;
  });

  it("docking is order-independent: task-tools listed before tool-bash still shares", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, createTaskToolsPlugin(), createLocalEnvPlugin(), createBashPlugin()]);
    const session = sid("dock-2");
    const started = await ctx.use(backgroundTasks).start({ command: "echo dock-order-ok", cwd: process.cwd(), session, env: createLocalEnv(process.cwd()) });
    expect(started.ok).toBe(true);
    const tasks = ctx.use(backgroundTasks);
    const id = started.ok ? started.value.id : "";
    const deadline = Date.now() + 5_000;
    while ((tasks.list(session).find((t) => t.id === id)?.endedAt) === undefined && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    const stopped = await ctx.use(toolRegistry).dispatch({ callId: "c1", name: "task_stop", args: { task_id: id }, signal: new AbortController().signal, session });
    expect(stopped.isError).toBeUndefined();
    expect(stopped.content).toContain("already finished");
    await ctx.dispose();
    void unload;
  });

  it("without bashTasks the hub answers unified not-found for bash-shaped ids", async () => {
    const { ctx, registry } = await assemble();
    const out = await registry.dispatch({ callId: "c1", name: "task_stop", args: { task_id: "t-ab12cd34ef56" }, signal: new AbortController().signal, session: sid("s") });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("no such task in any source");
    await ctx.dispose();
  });

  it("纯工具世界（无 agent-loop）：通知臂不挂——settle 后无 throw/无 stderr（负面断言：无观察通道，命名如实）", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, createLocalEnvPlugin(), createBashPlugin(), createTaskToolsPlugin()]);
    const session = sid("no-loop");
    const started = await ctx.use(backgroundTasks).start({ command: "echo no-loop", cwd: process.cwd(), session, env: createLocalEnv(process.cwd()) });
    expect(started.ok).toBe(true);
    const tasks = ctx.use(backgroundTasks);
    const id = started.ok ? started.value.id : "";
    const deadline = Date.now() + 5_000;
    while ((tasks.list(session).find((t) => t.id === id)?.endedAt) === undefined && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    expect(tasks.list(session).find((t) => t.id === id)?.state).toBe("completed");
    await ctx.dispose();
    void unload;
  });

  it("double assembly fails fast (duplicate tool name in the same registry)", async () => {
    const ctx = createContext();
    await expect(loadPlugins(ctx, [sessionPlugin, toolsPlugin, createTaskToolsPlugin(), createTaskToolsPlugin()])).rejects.toThrow();
    await ctx.dispose().catch(() => {});
  });
});
