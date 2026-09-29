import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "@x-harness/session";
import { scanAndRecover } from "../resume.ts";
import { attachOf, makeWorld, script, textsOf } from "./scan.test.ts";

describe("submitted 重派发（A3——§5.2 行 2）", () => {
  it("journal 停在 submitted → 活父扫描即重派发（dispatched 落账 + 子真跑）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-a3-"));
    const { openRunJournal, workflowPluginVersion } = await import("../journal.ts");
    const made = await openRunJournal(join(root, "workflows"), { runId: "r-a3", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
    if (made.kind !== "opened") throw new Error("fixture");
    await made.writer.append([{ type: "run/created", runId: "r-a3", parentSession: "main-1", cwd: root }]);
    await made.writer.append([{ type: "task/submitted", taskId: "t-r-a3", spec: { description: "d", prompt: "p" } }]);
    await made.writer.close();

    const world = await makeWorld(root, "main-1");
    world.scripts.set("m", [script('{"a":1}')]);
    await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "m", provider: "fake" } });
    const result = await scanAndRecover(world.deps, attachOf(world));
    expect(result.claimed).toBe(1);
    await vi.waitFor(() => expect(textsOf(world, "main-1")).toContain("workflow-notification"), { timeout: 5_000 });
    const journal = await readFile(join(root, "workflows", "r-a3", "journal.jsonl"), "utf8");
    expect(journal).toContain("task/dispatched");
    expect(journal).toContain("run/settled");
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("死父扫描：submitted 悬置（redispatch false）不炸不推进", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-a3b-"));
    const { openRunJournal, workflowPluginVersion } = await import("../journal.ts");
    const made = await openRunJournal(join(root, "workflows"), { runId: "r-a3b", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
    if (made.kind !== "opened") throw new Error("fixture");
    await made.writer.append([{ type: "run/created", runId: "r-a3b", parentSession: "main-1", cwd: root }]);
    await made.writer.append([{ type: "task/submitted", taskId: "t-r-a3b", spec: { description: "d", prompt: "p" } }]);
    await made.writer.close();
    const world = await makeWorld(root, "main-1");
    const result = await scanAndRecover(world.deps, attachOf(world));
    expect(result.claimed).toBe(1);
    const journal = await readFile(join(root, "workflows", "r-a3b", "journal.jsonl"), "utf8");
    expect(journal).not.toContain("task/dispatched");
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});




describe("§5.1 过滤分支补全（版本不符/活锁/frozen）", () => {
  it("pluginVersion 不符 → 只读跳过；header 损坏 → frozen 跳过；活锁 → busy 跳过（skipped 计数）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-flt-"));
    const { openRunJournal } = await import("../journal.ts");
    const v1 = await openRunJournal(join(root, "workflows"), { runId: "r-oldver", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: "0.0.1" });
    if (v1.kind !== "opened") throw new Error("fixture");
    await v1.writer.append([{ type: "run/created", runId: "r-oldver", parentSession: "main-1", cwd: root }]);
    await v1.writer.close();
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    await mkdir(join(root, "workflows", "r-badhdr"), { recursive: true });
    await wf(join(root, "workflows", "r-badhdr", "header.json"), "{trunc");
    const live = await openRunJournal(join(root, "workflows"), { runId: "r-livelock", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: (await import("../journal.ts")).workflowPluginVersion() });
    if (live.kind !== "opened") throw new Error("fixture");
    await live.writer.append([{ type: "run/created", runId: "r-livelock", parentSession: "main-1", cwd: root }]);
    await live.writer.append([{ type: "task/submitted", taskId: "t-r-livelock", spec: { description: "d", prompt: "p" } }]);

    const world = await makeWorld(root, "main-1");
    const result = await scanAndRecover(world.deps, attachOf(world));
    expect(result.claimed).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(3);
    const oldJournal = await readFile(join(root, "workflows", "r-oldver", "journal.jsonl"), "utf8");
    expect(oldJournal).not.toContain("task/dispatched");
    await live.writer.close();
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});




describe("B5：跨重启 settled 未投通知补投", () => {
  it("journal 停在 task/settled（无 notify/delivered）→ 扫描认领补投 + 收尾关卷", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-b5-"));
    const { openRunJournal, workflowPluginVersion } = await import("../journal.ts");
    const made = await openRunJournal(join(root, "workflows"), { runId: "r-b5", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
    if (made.kind !== "opened") throw new Error("fixture");
    await made.writer.append([{ type: "run/created", runId: "r-b5", parentSession: "main-1", cwd: root }]);
    await made.writer.append([{ type: "task/submitted", taskId: "t-r-b5", spec: { description: "d", prompt: "p" } }]);
    await made.writer.append([{ type: "task/dispatched", taskId: "t-r-b5", agentId: "agent-5b5b5b5b", sessionId: "x" }]);
    await made.writer.append([{ type: "task/settled", taskId: "t-r-b5", outcome: "completed", verdict: "schema:accept" }]);
    await made.writer.append([{ type: "run/settled", outcome: "completed", detail: "all tasks settled" }]);
    await made.writer.close();

    const world = await makeWorld(root, "main-1");
    await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "m", provider: "fake" } });
    const result = await scanAndRecover(world.deps, attachOf(world));
    expect(result.claimed).toBe(1);
    await vi.waitFor(() => expect(textsOf(world, "main-1")).toContain("workflow-notification"), { timeout: 5_000 });
    const journal = await readFile(join(root, "workflows", "r-b5", "journal.jsonl"), "utf8");
    expect(journal).toContain("notify/delivered");
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});



describe("B7：archive 缺席 → 未终态 run 冻结不认领", () => {
  it("无 archive 的 world：in-flight run skipped（锁释放、不 attach）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-b7-"));
    const { openRunJournal, workflowPluginVersion } = await import("../journal.ts");
    const made = await openRunJournal(join(root, "workflows"), { runId: "r-b7", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
    if (made.kind !== "opened") throw new Error("fixture");
    await made.writer.append([{ type: "run/created", runId: "r-b7", parentSession: "main-1", cwd: root }]);
    await made.writer.append([{ type: "task/submitted", taskId: "t-r-b7", spec: { description: "d", prompt: "p" } }]);
    await made.writer.close();

    const ctx = (await import("@x-harness/core")).createContext();
    const { loadPlugins } = await import("@x-harness/core");
    const { sessionPlugin: sp, sessionStore: st } = await import("@x-harness/session");
    const { llmPlugin: lp } = await import("@x-harness/llm");
    const { toolsPlugin: tp } = await import("@x-harness/tools");
    const { systemPromptPlugin: spp } = await import("@x-harness/system-prompt");
    const { agentLoopPlugin: alp, agentLoopServiceToken: alst } = await import("@x-harness/agent-loop");
    const { createTaskToolsPlugin: cttp } = await import("@x-harness/task-tools");
    const { createAgentDelegationPlugin: cadp } = await import("@x-harness/agent-delegation");
    const warnings: string[] = [];
    const { createRuntime } = await import("../runtime.ts");
    await loadPlugins(ctx, [sp, tp, spp, lp, alp, cttp(), cadp({ agentsDirs: [], workspaceRoot: root, worktreeSweep: false })]);
    const deps = { ctx, root: join(root, "workflows"), mainSession: "main-1" as SessionId, loop: ctx.use(alst), store: ctx.use(st), view: ctx.tryUse((await import("@x-harness/agent-delegation")).delegationView) ?? undefined, onWarn: (m: string) => warnings.push(m) };
    const workflow = createRuntime(deps);
    const result = await scanAndRecover({ ...deps, warmColdIndex: workflow.warmColdIndex }, (run) => ({ onCycleEnd: workflow.attach(run), redispatch: workflow.redispatch, detach: workflow.detach }));
    expect(result.claimed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(warnings.some((w) => w.includes("no session archive"))).toBe(true);
    await ctx.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

describe("verifying 崩溃窗口（D2——B-10 副作用双跑防线）", () => {
  it("journal 停在 verify/started（无 result）→ unknown 封口 + fail 终局（不重跑命令）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-d2-"));
    const { openRunJournal, workflowPluginVersion } = await import("../journal.ts");
    const made = await openRunJournal(join(root, "workflows"), { runId: "r-d2", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
    if (made.kind !== "opened") throw new Error("fixture");
    await made.writer.append([{ type: "run/created", runId: "r-d2", parentSession: "main-1", cwd: root }]);
    await made.writer.append([{ type: "task/submitted", taskId: "t-r-d2", spec: { description: "d", prompt: "p", acceptance: { command: "true" } } }]);
    await made.writer.append([{ type: "task/dispatched", taskId: "t-r-d2", agentId: "agent-d2d2d2d2", sessionId: "x" }]);
    await made.writer.append([{ type: "verify/started", taskId: "t-r-d2", tier: "command", attempt: 1 }]);
    await made.writer.close();

    const world = await makeWorld(root, "main-1");
    await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "m", provider: "fake" } });
    const result = await scanAndRecover(world.deps, attachOf(world));
    expect(result.claimed).toBe(1);
    await vi.waitFor(() => expect(textsOf(world, "main-1")).toContain("workflow-notification"), { timeout: 5_000 });
    const journal = await readFile(join(root, "workflows", "r-d2", "journal.jsonl"), "utf8");
    expect(journal).toContain('"outcome":"unknown"');
    expect(journal).toContain("verify-unknown");
    expect(journal).not.toContain('"outcome":"passed"');
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

describe("冷启动停止（期 2-D2——coldStop）", () => {
  it("未认领 run 的任务：task_stop 经盘扫落 settle{cancelled}（journal-only）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-cold-"));
    const { openRunJournal, workflowPluginVersion } = await import("../journal.ts");
    const made = await openRunJournal(join(root, "workflows"), { runId: "r-cold", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
    if (made.kind !== "opened") throw new Error("fixture");
    await made.writer.append([{ type: "run/created", runId: "r-cold", parentSession: "main-1", cwd: root }]);
    await made.writer.append([{ type: "task/submitted", taskId: "t-cold", spec: { description: "d", prompt: "p" } }]);
    await made.writer.append([{ type: "task/dispatched", taskId: "t-cold", agentId: "agent-c01d0000", sessionId: "x" }]);
    await made.writer.close();

    const world = await makeWorld(root, "main-1", { noArchive: true });
    await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "m", provider: "fake" } });
    await scanAndRecover(world.deps, attachOf(world));
    expect(world.workflow.probeTask("t-cold", "main-1" as SessionId)).toEqual({ kind: "hit" });
    const stopped = await world.workflow.stopTask("t-cold", "main-1" as SessionId);
    expect(stopped.ok).toBe(true);
    expect(stopped.ok === true && stopped.text).toContain("cancelled");
    const journal = await readFile(join(root, "workflows", "r-cold", "journal.jsonl"), "utf8");
    expect(journal).toContain('"cause":"task-stop"');
    expect(journal).toContain("run/settled");
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});
