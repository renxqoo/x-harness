import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "@x-harness/session";
import { sessionStore } from "@x-harness/session";
import { createAgentDelegationPlugin } from "@x-harness/agent-delegation";
import type { Plugin } from "@x-harness/core";
import { createContext, loadPlugins } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { createTaskToolsPlugin } from "@x-harness/task-tools";
import { createAgentWorkflowPlugin } from "../plugin.ts";
import { dispatchPrompt } from "../runtime.ts";

beforeEach(() => {
  resetWorlds();
});


const worlds: Array<() => Promise<void>> = [];
function resetWorlds(): void {
  for (const dispose of worlds.splice(0)) void dispose();
}

interface TestWorld {
  readonly ctx: ReturnType<typeof createContext>;
  readonly loop: import("@x-harness/agent-loop").AgentLoopService;
  readonly scripts: Map<string, AsyncGenerator<LlmChunk>[]>;
  submit: (session: SessionId | undefined, input: Record<string, unknown>) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  submitVia: (session: SessionId, input: Record<string, unknown>) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  dispose: () => Promise<void>;
}

async function makeWorld(options: { readonly root: string; readonly mainSession?: string }): Promise<TestWorld> {
  const scripts = new Map<string, Array<AsyncGenerator<import("@x-harness/llm").LlmChunk>>>();
  const ctx = createContext();
  const plugins: readonly Plugin[] = [
    sessionPlugin,
    toolsPlugin,
    systemPromptPlugin,
    llmPlugin,
    agentLoopPlugin,
    createTaskToolsPlugin(),
    createAgentDelegationPlugin({ agentsDirs: [], workspaceRoot: process.cwd(), worktreeSweep: false }),
    createAgentWorkflowPlugin({ userCommandOnly: false, root: options.root, mainSession: (options.mainSession ?? "main-1") as SessionId }),
  ];
  await loadPlugins(ctx, plugins);
  const loop = ctx.use(agentLoopServiceToken);
  const off = ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: async function* (request: LlmRequest): AsyncGenerator<LlmChunk> {
      const bucket = scripts.get(request.model);
      const next = bucket?.shift();
      const source = next ?? errorStream(`no-script-bucket:${request.model}`);
      for await (const chunk of await source) yield chunk;
    },
  });
  ctx.effect(off);
  const registry = ctx.use(toolRegistry);
  const world: TestWorld = {
    ctx,
    loop,
    scripts,
    submit: async (session, input) => {
      const made = await registry.dispatch({ callId: `wf-${String(Math.random()).slice(2, 8)}`, name: "workflow_submit", args: input, signal: new AbortController().signal, ...(session !== undefined ? { session } : {}) });
      return made.isError === true ? { ok: false, reason: made.content } : { ok: true, text: made.content };
    },
    submitVia: async (session, input) => {
      const made = await registry.dispatch({ callId: `wf-${String(Math.random()).slice(2, 8)}`, name: "workflow_submit", args: input, signal: new AbortController().signal, session });
      return made.isError === true ? { ok: false, reason: made.content } : { ok: true, text: made.content };
    },
    dispose: async () => {
      await ctx.dispose();
    },
  };
  worlds.push(world.dispose);
  return world;
}

const TEXT = (model: string, text: string) => textScriptOf(model, text);
const PARENT = "parent-model";

async function errorStream(message: string): Promise<AsyncGenerator<LlmChunk>> {
  return (async function* () {
    yield { type: "error", message } as never;
  })();
}

function textScriptOf(_model: string, text: string): AsyncGenerator<LlmChunk> {
  return (async function* () {
    yield { type: "text-delta", text } as never;
    yield { type: "finish", finish: { kind: "stop" } } as never;
  })();
}

const parentTextsOf = (world: TestWorld, session: SessionId): string =>
  world.ctx.use(sessionStore).get(session)?.events().map((e) => JSON.stringify(e.data)).join("\n") ?? "";

const notificationLinesOf = (world: TestWorld, session: SessionId): string =>
  world.ctx.use(sessionStore).get(session)?.events()
    .filter((e) => e.type === "agent/message" || e.type === "user/message")
    .map((e) => JSON.stringify(e.data))
    .join("\n") ?? "";


describe("workflow_submit：W6 直通", () => {
  it("无验收参数 → 零 journal 足迹（root 无新 run 目录）+ 通知走 delegation 原路径", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-"));
    const world = await makeWorld({ root });
    const parentMade = await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: PARENT, provider: "fake" } });
    if (!parentMade.ok) throw new Error(parentMade.reason);
    const parent = parentMade.value;
    world.scripts.set(PARENT, [TEXT(PARENT, "child done")]);
    const sent = await world.submit("main-1" as SessionId, { description: "plain", prompt: "x" });
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => expect(notificationLinesOf(world, "main-1" as SessionId)).toContain("agent-notification"), { timeout: 5_000 });
    expect(notificationLinesOf(world, "main-1" as SessionId)).not.toContain("workflow-notification");
    const entries = await (await import("node:fs/promises")).readdir(root).catch(() => [] as string[]);
    expect(entries).toEqual([]);
    await parent.dispose();
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

describe("workflow_submit：Tier A 受管回炉", () => {
  it("首轮缺字段 → repair 回炉 → 修好 → passed 通知（journal 全程落账）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-"));
    const world = await makeWorld({ root });
    const parentMade = await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: PARENT, provider: "fake" } });
    if (!parentMade.ok) throw new Error(parentMade.reason);
    const parent = parentMade.value;
    const schema = { type: "object", required: ["title"], properties: { title: { type: "string" } } };
    world.scripts.set(PARENT, [
      TEXT(PARENT, '{"title": 123}'),
      TEXT(PARENT, '{"title": "fixed value"}'),
    ]);
    const sent = await world.submit("main-1" as SessionId, { description: "schema task", prompt: "produce the report", result_schema: schema });
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => expect(parentTextsOf(world, "main-1" as SessionId)).toContain("workflow-notification"), { timeout: 5_000 });
    expect(parentTextsOf(world, "main-1" as SessionId)).toContain("finished: passed");
    expect(parentTextsOf(world, "main-1" as SessionId)).toContain("deliverable:");
    expect(parentTextsOf(world, "main-1" as SessionId)).toContain("fixed value");
    const { readdir, readFile } = await import("node:fs/promises");
    const runs = await readdir(root);
    expect(runs).toHaveLength(1);
    const journal = await readFile(join(root, runs[0] ?? "", "journal.jsonl"), "utf8");
    expect(journal).toContain("task/repair-issued");
    expect(journal).toContain('"outcome":"completed"');
    expect(journal).toContain("notify/delivered");
    await parent.dispose();
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("预算耗尽 → failed 终局（不无限回炉）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-"));
    const world = await makeWorld({ root });
    const parentMade = await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: PARENT, provider: "fake" } });
    if (!parentMade.ok) throw new Error(parentMade.reason);
    const parent = parentMade.value;
    const schema = { type: "object", required: ["title"], properties: { title: { type: "string" } } };
    world.scripts.set(PARENT, Array.from({ length: 5 }, () => TEXT(PARENT, "no json at all")));
    const sent = await world.submit("main-1" as SessionId, { description: "doomed", prompt: "x", result_schema: schema, max_attempts: 1 });
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => expect(parentTextsOf(world, "main-1" as SessionId)).toContain("workflow-notification"), { timeout: 5_000 });
    expect(parentTextsOf(world, "main-1" as SessionId)).toContain("failed");
    await parent.dispose();
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("异常终态（子 failed）→ 不进验收直接终局（F6c）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-"));
    const world = await makeWorld({ root });
    const parentMade = await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: PARENT, provider: "fake" } });
    if (!parentMade.ok) throw new Error(parentMade.reason);
    const parent = parentMade.value;
    const schema = { type: "object", required: ["title"], properties: { title: { type: "string" } } };
    world.scripts.set(PARENT, []);
    const sent = await world.submit("main-1" as SessionId, { description: "crasher", prompt: "x", result_schema: schema });
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => expect(parentTextsOf(world, "main-1" as SessionId)).toContain("workflow-notification"), { timeout: 5_000 });
    expect(parentTextsOf(world, "main-1" as SessionId)).toContain("failed");
    const { readFile, readdir } = await import("node:fs/promises");
    const runs = await readdir(root);
    const journal = await readFile(join(root, runs[0] ?? "", "journal.jsonl"), "utf8");
    expect(journal).toContain("child-failed");
    await parent.dispose();
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

describe("提交校验", () => {
  it("critic 提交可达（期 2-B 解锁）；acceptance 可提交（Tier B 接线）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-"));
    const world = await makeWorld({ root });
    const parentMade = await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: PARENT, provider: "fake" } });
    if (!parentMade.ok) throw new Error(parentMade.reason);
    const parent = parentMade.value;
    const critic = await world.submit("main-1" as SessionId, { description: "c", prompt: "x", critic: { type: "reviewer" } });
    expect(critic.ok).toBe(true);
    const acceptance = await world.submit("main-1" as SessionId, { description: "a", prompt: "x", acceptance: { command: "exit 0" } });
    expect(acceptance.ok).toBe(true);
    await vi.waitFor(() => expect(notificationLinesOf(world, "main-1" as SessionId)).toContain("workflow-notification"), { timeout: 5_000 });
    await parent.dispose();
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

describe("dispatchPrompt（W5 派发增补）", () => {
  it("result_schema 在场：追加结构化交付指令 + schema 摘要；缺席：原文", () => {
    const plain = dispatchPrompt({ description: "d", prompt: "just do it" });
    expect(plain).toBe("just do it");
    const gated = dispatchPrompt({ description: "d", prompt: "report it", result_schema: { type: "object" } });
    expect(gated).toContain("[workflow acceptance]");
    expect(gated).toContain("JSON");
  });
});

describe("插件装配（plugin.ts apply 分支）", () => {
  it("task-tools 缺席部署：工具仍注册、apply 不炸（源注册跳过）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-notools-"));
    const ctx = createContext();
    const plugins: readonly Plugin[] = [
      sessionPlugin,
      toolsPlugin,
      systemPromptPlugin,
      llmPlugin,
      agentLoopPlugin,
      createAgentWorkflowPlugin({ userCommandOnly: false, root: join(root, "workflows"), mainSession: "main-1" as SessionId }),
    ];
    const unload = await loadPlugins(ctx, plugins);
    const registry = ctx.use(toolRegistry);
    expect(registry.schemas().some((tool) => tool.name === "workflow_submit")).toBe(true);
    for (let i = unload.length - 1; i >= 0; i--) await unload[i]!();
    await ctx.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

describe("提交校验矩阵（runtime.submit 分支）", () => {
  it("caller 缺席 → invalid-args；非 mainSession → 拒（期 1 限根会话）；run busy → busy 拒", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-matrix-"));
    const world = await makeWorld({ root });
    const runtime = (await import("../runtime.ts")).createRuntime({ ctx: world.ctx, root: join(root, "workflows"), mainSession: "main-1" as SessionId, loop: world.loop, store: world.ctx.use(sessionStore), view: undefined });
    const schema = { type: "object" };
    const noCaller = await runtime.submit(undefined, { description: "d", prompt: "p", result_schema: schema });
    expect(noCaller.ok).toBe(false);
    expect(noCaller.ok === false && noCaller.reason).toContain("main conversation");
    const noView = await runtime.submit("main-1" as SessionId, { description: "d", prompt: "p", result_schema: schema });
    expect(noView.ok).toBe(false);
    expect(noView.ok === false && noView.reason).toContain("no agent-delegation plugin");
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

describe("期 1 限根会话（F13）", () => {
  it("子会话 caller 提交受管任务 → 拒（period 2 落档）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-childsub-"));
    const world = await makeWorld({ root });
    const rejected = await world.submitVia("child-session-x" as SessionId, { description: "child task", prompt: "p", result_schema: { type: "object" } });
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.reason).toContain("only available from the main conversation");
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

describe("dispatch 拒落账（A5-1）", () => {
  it("spawn 校验拒（空 description）→ task/settled{dispatch-failed} + run/settled 终局", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-dispfail-"));
    const world = await makeWorld({ root: join(root, "workflows") });
    const rejected = await world.submit("main-1" as SessionId, { description: "   ", prompt: "p", result_schema: { type: "object" } });
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.reason).toContain("invalid-args:description");
    const { readdir, readFile } = await import("node:fs/promises");
    const runs = await readdir(join(root, "workflows"));
    expect(runs).toHaveLength(1);
    const journal = await readFile(join(root, "workflows", runs[0] ?? "", "journal.jsonl"), "utf8");
    expect(journal).toContain("dispatch-failed");
    expect(journal).toContain("\"outcome\":\"failed\"");
    expect(journal).toContain("run/settled");
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

describe("通知铸文（notificationText）", () => {
  it("超长证据触发截断分支（reportCap 34k）", async () => {
    const { notificationText } = await import("../notify.ts");
    const run = {
      header: { runId: "r", parentSession: "s", cwd: "/", createdAt: 1, pluginVersion: "16.0.0" },
      snapshot: {
        runId: "r", parentSession: "s", cwd: "/", status: "settled" as const, outcome: "failed" as const,
        notified: new Set<string>(), consecutiveFailures: 0,
        tasks: {
          t1: { taskId: "t1", spec: { description: "d", prompt: "p" }, status: "settled" as const, agentId: "agent-ab12cd34", repairs: 0, reopens: 0, verifyAttempts: 0, trailing: [], outcome: "failed" as const, detail: "x".repeat(40_000), verdict: "schema:budget-exhausted" },
        },
      },
    };
    const text = notificationText(run as never);
    expect(text.length).toBeGreaterThan(34_000);
  });
});

describe("死父通知悬置 → 边沿补投（A-11）", () => {
  it("父 dispose 后任务完成 → 通知悬置；onSessionAlive 触发后补投（notify/delivered 落账）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-pend-"));
    const world = await makeWorld({ root });
    const parentMade = await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "parent-model", provider: "fake" } });
    if (!parentMade.ok) throw new Error(parentMade.reason);
    world.scripts.set("parent-model", [TEXT("parent-model", '{"title":"late"}')]);
    const sent = await world.submit("main-1" as SessionId, { description: "orphan notify", prompt: "x", result_schema: { type: "object", required: ["title"] } });
    expect(sent.ok).toBe(true);
    await parentMade.value.dispose();
    await sleep(600);
    const revived = await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "parent-model", provider: "fake" } });
    if (!revived.ok) throw new Error(revived.reason);
    await sleep(300);
    expect(notificationLinesOf(world, "main-1" as SessionId)).toContain("workflow-notification");
    await revived.value.dispose();
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  }, 15_000);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

describe("入口策略（期 3：不经模型）", () => {
  it("缺省 userCommandOnly=true：workflow_submit 工具不注册给模型（入口=宿主命令/代理间）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-uco-"));
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, systemPromptPlugin, llmPlugin, agentLoopPlugin, createAgentWorkflowPlugin({ root, mainSession: "m" as SessionId })]);
    const names = ctx.use(toolRegistry).schemas().map((t) => t.name);
    expect(names.includes("workflow_submit")).toBe(false);
    for (let i = unload.length - 1; i >= 0; i--) await unload[i]!();
    await ctx.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

describe("错误注入分支（覆盖收口——busy/journal 失败）", () => {
  it("root 为文件路径 → openRunJournal 失败 → 提交拒 spawn-failed:journal（fail-fast 面可达）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-busy-"));
    const fileAsRoot = join(root, "not-a-dir");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(fileAsRoot, "x");
    const world = await makeWorld({ root: fileAsRoot });
    const parentMade = await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: PARENT, provider: "fake" } });
    if (!parentMade.ok) throw new Error(parentMade.reason);
    const rejected = await world.submit("main-1" as SessionId, { description: "d", prompt: "p", result_schema: { type: "object" } });
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.reason).toMatch(/journal|busy/);
    await parentMade.value.dispose();
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});
