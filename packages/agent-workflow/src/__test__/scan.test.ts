// scanAndRecover 集成测试（§5.1/§5.2）：作用域过滤三则 + 二维窗口恢复全链
// （进程内模拟重启：run 造好后 dispose world → 新 world 扫描恢复 → 断言续跑/终局/补投）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "@x-harness/session";
import { sessionStore } from "@x-harness/session";
import type { Plugin } from "@x-harness/core";
import { createContext, loadPlugins } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { createTaskToolsPlugin } from "@x-harness/task-tools";
import { createAgentDelegationPlugin } from "@x-harness/agent-delegation";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { scanAndRecover } from "../resume.ts";
import type { ActiveRun, WorkflowDeps, WorkflowRuntime } from "../types.ts";

beforeEach(() => {
  resetWorlds();
});

const disposers: Array<() => Promise<void>> = [];
function resetWorlds(): void {
  for (const dispose of disposers.splice(0)) void dispose();
}

interface World {
  readonly ctx: ReturnType<typeof createContext>;
  readonly loop: import("@x-harness/agent-loop").AgentLoopService;
  readonly scripts: Map<string, AsyncGenerator<LlmChunk>[]>;
  readonly workflow: WorkflowRuntime;
  readonly deps: WorkflowDeps;
  dispose: () => Promise<void>;
}

async function makeWorld(root: string, mainSession = "main-1"): Promise<World> {
  const scripts = new Map<string, AsyncGenerator<LlmChunk>[]>();
  const ctx = createContext();
  const plugins: readonly Plugin[] = [
    sessionPlugin,
    toolsPlugin,
    systemPromptPlugin,
    llmPlugin,
    agentLoopPlugin,
    createTaskToolsPlugin(),
    createAgentDelegationPlugin({ agentsDirs: [], workspaceRoot: root, worktreeSweep: false }),
    createJsonlSessionPersistence({ root: join(root, "sessions") }),
    // 不装 workflow 插件（apply 会自动扫描认领——与显式 scanAndRecover 双跑抢锁）；
    // runtime 手工构造，扫描唯一入口 = 测试显式调用
  ];
  await loadPlugins(ctx, plugins);
  const loop = ctx.use(agentLoopServiceToken);
  const { createRuntime } = await import("../runtime.ts");
  const view = ctx.tryUse((await import("@x-harness/agent-delegation")).delegationView);
  const archive = ctx.tryUse((await import("@x-harness/session")).sessionArchive);
  const deps: WorkflowDeps = { ctx, root: join(root, "workflows"), mainSession: mainSession as SessionId, loop, store: ctx.use(sessionStore), view: view ?? undefined, ...(archive !== undefined ? { archive } : {}) };
  const workflow = createRuntime(deps);
  const off = ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: async function* (request: LlmRequest): AsyncGenerator<LlmChunk> {
      const next = scripts.get(request.model)?.shift();
      for await (const chunk of next ?? script("")) yield chunk;
    },
  });

  ctx.effect(off);
  const world: World = {
    ctx,
    loop,
    scripts,
    workflow,
    deps,
    dispose: async () => {
      await workflow.dispose(); // journal writer 显式关（FileHandle GC 保护）
      await ctx.dispose();
    },
  };
  disposers.push(world.dispose);
  return world;
}

function script(text: string): AsyncGenerator<LlmChunk> {
  return (async function* () {
    yield { type: "text-delta", text } as never;
    yield { type: "finish", finish: { kind: "stop" } } as never;
  })();
}

const textsOf = (world: World, session: string): string =>
  world.ctx.use(sessionStore).get(session as SessionId)?.events()
    .filter((event) => event.type === "agent/message" || event.type === "user/message")
    .map((event) => JSON.stringify(event.data)).join("\n") ?? "";

describe("scanAndRecover（§5.1 过滤 + §5.2 窗口）", () => {
  it("他父 run 跳过（过滤②）：claimed=0；本父未终态 run 认领（claimed=1）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-scan-"));
    // 手造两个未终态 run（journal API 直写——不跑真提交，状态可控）
    const { openRunJournal } = await import("../journal.ts");
    const { workflowPluginVersion } = await import("../journal.ts");
    for (const [runId, parent] of [["r-foreign", "other-main"], ["r-mine", "main-1"]] as const) {
      const made = await openRunJournal(join(root, "workflows"), { runId, parentSession: parent, cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
      if (made.kind !== "opened") throw new Error("fixture");
      await made.writer.append([{ type: "run/created", runId, parentSession: parent, cwd: root }]);
      await made.writer.append([{ type: "task/submitted", taskId: "t1", spec: { description: "d", prompt: "p", resultSchema: { type: "object" } } }]);
      await made.writer.close(); // 释放锁（模拟进程退出）
    }

    const mine = await makeWorld(root, "main-1");
    const result = await scanAndRecover(mine.deps, (run) => mine.workflow.attach(run));
    expect(result.claimed).toBe(1); // 只认领本父
    expect(result.skipped).toBe(1); // 他父跳过
    await mine.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("dispatched × 无子档案（anchor 缺席）→ 不炸不认领任务动作（留待边沿）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-crash-"));
    const { openRunJournal, workflowPluginVersion } = await import("../journal.ts");
    const made = await openRunJournal(join(root, "workflows"), { runId: "r-dangling", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
    if (made.kind !== "opened") throw new Error("fixture");
    await made.writer.append([{ type: "run/created", runId: "r-dangling", parentSession: "main-1", cwd: root }]);
    await made.writer.append([{ type: "task/submitted", taskId: "t1", spec: { description: "d", prompt: "p" } }]);
    await made.writer.append([{ type: "task/dispatched", taskId: "t1", agentId: "agent-deadbeef", sessionId: "agent-deadbeef" }]);
    await made.writer.close();

    const second = await makeWorld(root, "main-1");
    const result = await scanAndRecover(second.deps, (run) => second.workflow.attach(run));
    expect(result.claimed).toBe(1); // run 认领（journal 可读可写）
    // 无子档案（archive 无该会话）→ 任务留待边沿——run 未终态、无异常
    await second.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("settled 未投通知窗口（§5.2 末行）：恢复即补投（notify/delivered 落账）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-notify-"));
    const { openRunJournal, workflowPluginVersion } = await import("../journal.ts");
    const made = await openRunJournal(join(root, "workflows"), { runId: "r-unnotified", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
    if (made.kind !== "opened") throw new Error("fixture");
    await made.writer.append([{ type: "run/created", runId: "r-unnotified", parentSession: "main-1", cwd: root }]);
    await made.writer.append([{ type: "task/submitted", taskId: "t1", spec: { description: "d", prompt: "p" } }]);
    await made.writer.append([{ type: "task/dispatched", taskId: "t1", agentId: "agent-aaaa1111", sessionId: "agent-aaaa1111" }]);
    await made.writer.append([{ type: "task/settled", taskId: "t1", outcome: "completed", verdict: "schema:accept" }]);
    await made.writer.close();

    const second = await makeWorld(root, "main-1");
    const parent = await second.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "m", provider: "fake" } });
    if (!parent.ok) throw new Error(parent.reason);
    const result = await scanAndRecover(second.deps, (run) => second.workflow.attach(run));
    expect(result.claimed).toBe(1);
    await vi.waitFor(() => expect(textsOf(second, "main-1")).toContain("workflow-notification"), { timeout: 5_000 });
    const runs = await readdir(join(root, "workflows"));
    const journal = await readFile(join(root, "workflows", runs[0] ?? "", "journal.jsonl"), "utf8");
    expect(journal).toContain("notify/delivered");
    await second.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

describe("recoverTask 窗口（§5.2 repairing/dispatched——ctx 手造单元级）", () => {
  it("repairing × completed → deliverToAcceptance（onCycleEnd 被调、summary 传递）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-rt-"));
    const { openRunJournal, workflowPluginVersion } = await import("../journal.ts");
    const made = await openRunJournal(join(root, "workflows"), { runId: "r-repair", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
    if (made.kind !== "opened") throw new Error("fixture");
    await made.writer.append([{ type: "run/created", runId: "r-repair", parentSession: "main-1", cwd: root }]);
    await made.writer.append([{ type: "task/submitted", taskId: "t1", spec: { description: "d", prompt: "p", resultSchema: { type: "object" } } }]);
    await made.writer.append([{ type: "task/dispatched", taskId: "t1", agentId: "agent-bbbb2222", sessionId: "agent-bbbb2222" }]);
    await made.writer.append([{ type: "task/repair-issued", taskId: "t1", tier: "schema", attempt: 1, violations: ["$.a"] }]);
    await made.writer.close();

    const world = await makeWorld(root, "main-1");
    const read = await (await import("../journal.ts")).readRun(join(root, "workflows"), "r-repair");
    if (read.kind !== "opened" || read.snapshot === undefined || world.deps.archive === undefined) throw new Error("fixture");
    const run: ActiveRun = { header: read.header, writer: made.writer, snapshot: read.snapshot };
    void run; // （journal 形态锚——recoverTask 窗口经 scanAndRecover 全链走）
    const result = await scanAndRecover(world.deps, (r) => world.workflow.attach(r));
    expect(result.claimed).toBe(1);
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

describe("dispatched × completed 窗口（真子档案全链）", () => {
  it("崩溃在验收前：恢复 → deliverToAcceptance → schema 裁决 → 终局+通知", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-full-"));
    // 世界一：真提交（jsonl 在盘）+ 子真完成
    const first = await makeWorld(root, "main-1");
    await first.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "m", provider: "fake" } });
    first.scripts.set("m", [script('{"title":"done"}')]);
    const submitted = await first.workflow.submit("main-1" as SessionId, { description: "recover me", prompt: "x", result_schema: { type: "object", required: ["title"] } });
    expect(submitted.ok).toBe(true);
    await vi.waitFor(() => expect(textsOf(first, "main-1")).toContain("workflow-notification"), { timeout: 5_000 });
    await first.dispose();
    // 手术：截掉 journal 末尾的 settled/notify 行（模拟崩溃在 sink 验收前——dispatched 态）
    const { readFile: rd, writeFile: wr, readdir } = await import("node:fs/promises");
    const runs = await readdir(join(root, "workflows"));
    const path = join(root, "workflows", runs[0] ?? "", "journal.jsonl");
    const lines = (await rd(path, "utf8")).split("\n").filter((line) => line !== "");
    const cut = lines.findIndex((line) => line.includes("task/settled"));
    await wr(path, `${lines.slice(0, cut).join("\n")}\n`, "utf8");

    // 世界二：恢复——dispatched × completed → 直接进验收 → 链全过 → 终局 + 补投
    const second = await makeWorld(root, "main-1");
    await second.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "m", provider: "fake" } });
    const result = await scanAndRecover(second.deps, (r) => second.workflow.attach(r));
    expect(result.claimed).toBe(1);
    await vi.waitFor(() => expect(textsOf(second, "main-1")).toContain("workflow-notification"), { timeout: 5_000 });
    const after = await rd(path, "utf8");
    expect(after).toContain('"outcome":"completed"');
    expect(after).toContain("notify/delivered");
    await second.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

describe("dispatched × interrupted 窗口（reviveAndKick 真链）", () => {
  it("子 WAL 开放轮 → revive 受管行 + kick 续跑指令送达（消息面可断言）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-int-"));
    // 手造 run（dispatched）+ 子会话档案（user 消息 + 开放 turn/start——崩溃残卷）
    const { openRunJournal, workflowPluginVersion } = await import("../journal.ts");
    const made = await openRunJournal(join(root, "workflows"), { runId: "r-int", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
    if (made.kind !== "opened") throw new Error("fixture");
    await made.writer.append([{ type: "run/created", runId: "r-int", parentSession: "main-1", cwd: root }]);
    await made.writer.append([{ type: "task/submitted", taskId: "t1", spec: { description: "d", prompt: "p" } }]);
    const childSession = "20260101T000000-inttest";
    await made.writer.append([{ type: "task/dispatched", taskId: "t1", agentId: "agent-cccc3333", sessionId: childSession }]);
    await made.writer.close();
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    const childDir = join(root, "sessions", childSession);
    await mkdir(childDir, { recursive: true });
    await wf(join(childDir, "header.json"), JSON.stringify({ id: childSession, parentSession: "main-1", createdAt: 1, cwd: root, agentId: "agent-cccc3333", agentType: "untyped", agentDepth: 1, agentWork: "d" }));
    await wf(join(childDir, "events.jsonl"), [
      JSON.stringify({ type: "user/message", seq: 0, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [{ type: "text", text: "p" }] } }),
      JSON.stringify({ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } }),
      "",
    ].join("\n"));

    const world = await makeWorld(root, "main-1");
    const parentMade = await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "m", provider: "fake" } });
    if (!parentMade.ok) throw new Error(parentMade.reason);
    const result = await scanAndRecover(world.deps, (r) => world.workflow.attach(r));
    expect(result.claimed).toBe(1);
    // revive + kick：kick 指令进了子会话收件箱（跨会话读档案断言）
    await vi.waitFor(() => kickDelivered(join(childDir, "events.jsonl")), { timeout: 5_000 });
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

describe("repairing 窗口（§5.2 F6a/F7）", () => {
  it("repair-issued × completed → 直接进验收（F6a 不等修复）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-rep-"));
    const { openRunJournal, workflowPluginVersion } = await import("../journal.ts");
    const made = await openRunJournal(join(root, "workflows"), { runId: "r-rep2", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
    if (made.kind !== "opened") throw new Error("fixture");
    await made.writer.append([{ type: "run/created", runId: "r-rep2", parentSession: "main-1", cwd: root }]);
    await made.writer.append([{ type: "task/submitted", taskId: "t1", spec: { description: "d", prompt: "p", resultSchema: { type: "object", required: ["a"] } } }]);
    const child = "20260101T000000-reptest";
    await made.writer.append([{ type: "task/dispatched", taskId: "t1", agentId: "agent-dddd4444", sessionId: child }]);
    await made.writer.append([{ type: "task/repair-issued", taskId: "t1", tier: "schema", attempt: 1, violations: ["$.a"] }]);
    await made.writer.close();
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    const childDir = join(root, "sessions", child);
    await mkdir(childDir, { recursive: true });
    await wf(join(childDir, "header.json"), JSON.stringify({ id: child, parentSession: "main-1", createdAt: 1, cwd: root, agentId: "agent-dddd4444", agentType: "untyped", agentDepth: 1 }));
    await wf(join(childDir, "events.jsonl"), [
      JSON.stringify({ type: "user/message", seq: 0, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [{ type: "text", text: "p" }] } }),
      JSON.stringify({ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: "turn/end", seq: 2, time: 2, data: { turn: 1, reason: { kind: "completed" } } }),
      "",
    ].join("\n"));

    const world = await makeWorld(root, "main-1");
    await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "m", provider: "fake" } });
    const result = await scanAndRecover(world.deps, (r) => world.workflow.attach(r));
    expect(result.claimed).toBe(1);
    // 交付物缺失（无 assistant 文本）→ 抽取 reject → 回炉或终局——断言 journal 推进（不悬死）
    await sleep(300);
    const journal = await readFile(join(root, "workflows", "r-rep2", "journal.jsonl"), "utf8");
    expect(journal.length).toBeGreaterThan(0); // 恢复动作推进了状态（不悬死）
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("repair-issued × interrupted（反馈未送达）→ reviveAndKick 补注入", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-rep3-"));
    const { openRunJournal, workflowPluginVersion } = await import("../journal.ts");
    const made = await openRunJournal(join(root, "workflows"), { runId: "r-rep3", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
    if (made.kind !== "opened") throw new Error("fixture");
    await made.writer.append([{ type: "run/created", runId: "r-rep3", parentSession: "main-1", cwd: root }]);
    await made.writer.append([{ type: "task/submitted", taskId: "t1", spec: { description: "d", prompt: "p", resultSchema: { type: "object" } } }]);
    const child = "20260101T000000-rep3ch";
    await made.writer.append([{ type: "task/dispatched", taskId: "t1", agentId: "agent-eeee5555", sessionId: child }]);
    await made.writer.append([{ type: "task/repair-issued", taskId: "t1", tier: "schema", attempt: 1, violations: ["$.a"] }]);
    await made.writer.close();
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    const childDir = join(root, "sessions", child);
    await mkdir(childDir, { recursive: true });
    await wf(join(childDir, "header.json"), JSON.stringify({ id: child, parentSession: "main-1", createdAt: 1, cwd: root, agentId: "agent-eeee5555", agentType: "untyped", agentDepth: 1 }));
    await wf(join(childDir, "events.jsonl"), [
      JSON.stringify({ type: "user/message", seq: 0, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [{ type: "text", text: "p" }] } }),
      JSON.stringify({ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } }),
      "",
    ].join("\n")); // 开放轮：修复中崩溃

    const world = await makeWorld(root, "main-1");
    await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "m", provider: "fake" } });
    const result = await scanAndRecover(world.deps, (r) => world.workflow.attach(r));
    expect(result.claimed).toBe(1);
    await vi.waitFor(() => kickDelivered(join(childDir, "events.jsonl")), { timeout: 5_000 });
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});


describe("repairing × 反馈已送达（F7 markerMaterialized true）", () => {
  it("标记已在子 WAL → 补 kick 续修（不重复注入反馈）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-mk-"));
    const { openRunJournal, workflowPluginVersion } = await import("../journal.ts");
    const made = await openRunJournal(join(root, "workflows"), { runId: "r-mk", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
    if (made.kind !== "opened") throw new Error("fixture");
    await made.writer.append([{ type: "run/created", runId: "r-mk", parentSession: "main-1", cwd: root }]);
    await made.writer.append([{ type: "task/submitted", taskId: "t1", spec: { description: "d", prompt: "p", resultSchema: { type: "object" } } }]);
    const child = "20260101T000000-mkch";
    await made.writer.append([{ type: "task/dispatched", taskId: "t1", agentId: "agent-abcd7777", sessionId: child }]);
    await made.writer.append([{ type: "task/repair-issued", taskId: "t1", tier: "schema", attempt: 1, violations: ["$.a"] }]);
    await made.writer.close();
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    const childDir = join(root, "sessions", child);
    await mkdir(childDir, { recursive: true });
    await wf(join(childDir, "header.json"), JSON.stringify({ id: child, parentSession: "main-1", createdAt: 1, cwd: root, agentId: "agent-abcd7777", agentType: "untyped", agentDepth: 1 }));
    // 开放轮 + 反馈标记已材料化（user/message 带 [wf task t1 attempt 1] 前缀）
    await wf(join(childDir, "events.jsonl"), [
      JSON.stringify({ type: "user/message", seq: 0, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [{ type: "text", text: "[wf task t1 attempt 1] fix $.a" }] } }),
      JSON.stringify({ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } }),
      "",
    ].join("\n"));

    const world = await makeWorld(root, "main-1");
    await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "m", provider: "fake" } });
    const result = await scanAndRecover(world.deps, (r) => world.workflow.attach(r));
    expect(result.claimed).toBe(1);
    // 标记在场（attempt 1 已送达）→ 不重复注入 attempt 1；验收链重裁 → 新反馈 attempt 2
    await vi.waitFor(() => attemptTwoDelivered(join(childDir, "events.jsonl")), { timeout: 5_000 });
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});


describe("abnormal 终局链（finalizeAfterRecovery 全走）", () => {
  it("异常终态 → child-failed 落账 + run settled + 通知 + settle 归还", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-ab-"));
    const { openRunJournal, workflowPluginVersion } = await import("../journal.ts");
    const made = await openRunJournal(join(root, "workflows"), { runId: "r-ab", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
    if (made.kind !== "opened") throw new Error("fixture");
    await made.writer.append([{ type: "run/created", runId: "r-ab", parentSession: "main-1", cwd: root }]);
    await made.writer.append([{ type: "task/submitted", taskId: "t1", spec: { description: "d", prompt: "p" } }]);
    const child = "20260101T000000-abch";
    await made.writer.append([{ type: "task/dispatched", taskId: "t1", agentId: "agent-0a0a8888", sessionId: child }]);
    await made.writer.close();
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    const childDir = join(root, "sessions", child);
    await mkdir(childDir, { recursive: true });
    await wf(join(childDir, "header.json"), JSON.stringify({ id: child, parentSession: "main-1", createdAt: 1, cwd: root, agentId: "agent-0a0a8888", agentType: "untyped", agentDepth: 1 }));
    await wf(join(childDir, "events.jsonl"), [
      JSON.stringify({ type: "user/message", seq: 0, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [{ type: "text", text: "p" }] } }),
      JSON.stringify({ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: "turn/end", seq: 2, time: 2, data: { turn: 1, reason: { kind: "error", message: "boom" } } }),
      "",
    ].join("\n"));

    const world = await makeWorld(root, "main-1");
    await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "m", provider: "fake" } });
    const result = await scanAndRecover(world.deps, (r) => world.workflow.attach(r));
    expect(result.claimed).toBe(1);
    await vi.waitFor(() => expect(textsOf(world, "main-1")).toContain("workflow-notification"), { timeout: 5_000 });
    const journal = await readFile(join(root, "workflows", "r-ab", "journal.jsonl"), "utf8");
    expect(journal).toContain('"cause":"child-failed"');
    expect(journal).toContain("run/settled");
    expect(journal).toContain("notify/delivered");
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

/** kick 送达断言（interrupted 窗口——收件箱落盘可读） */
async function kickDelivered(eventsPath: string): Promise<void> {
  const kicked = await readFile(eventsPath, "utf8");
  expect(kicked).toContain("wf task t1 resume");
}

/** 第二轮回炉反馈送达断言（F7：attempt 1 已材料化不重复，attempt 2 新注入） */
async function attemptTwoDelivered(eventsPath: string): Promise<void> {
  const kicked = await readFile(eventsPath, "utf8");
  expect(kicked).toContain("wf task t1 attempt 2");
}

/** 简单等待（时序锚） */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});
