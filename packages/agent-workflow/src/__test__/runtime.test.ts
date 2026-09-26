// 件16 插件层单测：受管提交全旅程（Tier A 验收回炉闭环）+ W6 直通 + 派发 prompt 增补 +
// 边沿补投。装置复用 delegation 测试 world（脚本假 adapter）。

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

// ————————————————— 装置（delegation world 的同构内联——workflow 装配面） —————————————————

const worlds: Array<() => Promise<void>> = [];
function resetWorlds(): void {
  for (const dispose of worlds.splice(0)) void dispose();
}

interface TestWorld {
  readonly ctx: ReturnType<typeof createContext>;
  readonly loop: import("@x-harness/agent-loop").AgentLoopService;
  readonly scripts: Map<string, AsyncGenerator<LlmChunk>[]>;
  submit: (session: SessionId | undefined, input: Record<string, unknown>) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
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
    createAgentWorkflowPlugin({ root: options.root, mainSession: (options.mainSession ?? "main-1") as SessionId }),
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
// （stream 生成器内 for-await 直接消费 errorStream 产出——网络错误形态对齐 delegation world）

function textScriptOf(_model: string, text: string): AsyncGenerator<LlmChunk> {
  return (async function* () {
    yield { type: "text-delta", text } as never;
    yield { type: "finish", finish: { kind: "stop" } } as never;
  })();
}

const parentTextsOf = (world: TestWorld, session: SessionId): string =>
  world.ctx.use(sessionStore).get(session)?.events().map((e) => JSON.stringify(e.data)).join("\n") ?? "";

/** 通知行判定（排除工具描述文本中的字样——请求头里的 tools 列表会带描述） */
const notificationLinesOf = (world: TestWorld, session: SessionId): string =>
  world.ctx.use(sessionStore).get(session)?.events()
    .filter((e) => e.type === "agent/message" || e.type === "user/message")
    .map((e) => JSON.stringify(e.data))
    .join("\n") ?? "";

// ————————————————— 用例 —————————————————

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
    // 通知原路径：[agent-notification]（非 workflow-notification）——消息面判定（排除工具描述文本）
    await vi.waitFor(() => expect(notificationLinesOf(world, "main-1" as SessionId)).toContain("agent-notification"), { timeout: 5_000 });
    expect(notificationLinesOf(world, "main-1" as SessionId)).not.toContain("workflow-notification");
    const entries = await (await import("node:fs/promises")).readdir(root).catch(() => [] as string[]);
    expect(entries).toEqual([]); // 零 journal 足迹（A3 断言面）
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
      TEXT(PARENT, '{"title": 123}'),          // 首轮：类型错
      TEXT(PARENT, '{"title": "fixed value"}'), // 回炉后：合格
    ]);
    const sent = await world.submit("main-1" as SessionId, { description: "schema task", prompt: "produce the report", result_schema: schema });
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => expect(parentTextsOf(world, "main-1" as SessionId)).toContain("workflow-notification"), { timeout: 5_000 });
    expect(parentTextsOf(world, "main-1" as SessionId)).toContain("finished: passed");
    // journal 落账验证：run 目录存在且事件卷含 repair-issued 与终态
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
    // 让子代理直接 error：bucket 空 → errorStream
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
  it("delegation 缺席部署 → invalid-args（fail-closed）；critic 期 2 拒；acceptance 期 1b 拒", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-"));
    const world = await makeWorld({ root });
    const parentMade = await world.loop.create({ session: { id: "main-1" as SessionId }, agent: { model: PARENT, provider: "fake" } });
    if (!parentMade.ok) throw new Error(parentMade.reason);
    const parent = parentMade.value;
    const critic = await world.submit("main-1" as SessionId, { description: "c", prompt: "x", critic: { type: "reviewer" } });
    expect(critic.ok).toBe(false);
    expect(critic.ok === false && critic.reason).toContain("critic");
    const acceptance = await world.submit("main-1" as SessionId, { description: "a", prompt: "x", acceptance: { command: "true" } });
    expect(acceptance.ok).toBe(false);
    expect(acceptance.ok === false && acceptance.reason).toContain("period 1b");
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
