import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
import { toolRegistry, toolsPlugin } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { createTaskToolsPlugin } from "@x-harness/task-tools";
import { createAgentDelegationPlugin } from "@x-harness/agent-delegation";
import { createAgentWorkflowPlugin } from "../plugin.ts";
import { fold } from "@x-harness/workflow-core";
import type { WorkflowEvent } from "@x-harness/workflow-core";

function textScript(text: string): AsyncGenerator<LlmChunk> {
  return (async function* () {
    yield { type: "text-delta", text } as never;
    yield { type: "finish", finish: { kind: "stop" } } as never;
  })();
}

interface Fixture {
  readonly ctx: ReturnType<typeof createContext>;
  readonly loop: import("@x-harness/agent-loop").AgentLoopService;
  readonly scripts: Map<string, AsyncGenerator<LlmChunk>[]>;
  readonly workflow: { rebind(next: SessionId): Promise<{ ok: true } | { ok: false; reason: string }> };
  readonly submit: (session: SessionId, input: Record<string, unknown>) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  readonly texts: (session: string) => string;
  readonly dispose: () => Promise<void>;
}

async function makeFixture(root: string, mainSession = "sess-old"): Promise<Fixture> {
  const scripts = new Map<string, AsyncGenerator<LlmChunk>[]>();
  const ctx = createContext();
  const plugins: readonly Plugin[] = [
    sessionPlugin, toolsPlugin, systemPromptPlugin, llmPlugin, agentLoopPlugin, createTaskToolsPlugin(),
    createAgentDelegationPlugin({ agentsDirs: [], workspaceRoot: root, worktreeSweep: false }),
    createAgentWorkflowPlugin({ userCommandOnly: false, root: join(root, "workflows"), mainSession: mainSession as SessionId }),
  ];
  await loadPlugins(ctx, plugins);
  const loop = ctx.use(agentLoopServiceToken);
  const { workflowView } = await import("../plugin.ts");
  const workflow = ctx.use(workflowView);
  const off = ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: async function* (request: LlmRequest): AsyncGenerator<LlmChunk> {
      for await (const chunk of scripts.get(request.model)?.shift() ?? textScript("")) yield chunk;
    },
  });
  ctx.effect(off);
  const registry = ctx.use(toolRegistry);
  const f: Fixture = {
    ctx, loop, scripts, workflow,
    submit: async (session, input) => {
      const made = await registry.dispatch({ callId: `t-${String(Math.random()).slice(2, 8)}`, name: "workflow_submit", args: input, signal: new AbortController().signal, session });
      return made.isError === true ? { ok: false, reason: made.content } : { ok: true, text: made.content };
    },
    texts: (session) => ctx.use(sessionStore).get(session as SessionId)?.events()
      .filter((e) => e.type === "agent/message" || e.type === "user/message")
      .map((e) => JSON.stringify(e.data)).join("\n") ?? "",
    dispose: async () => {
      await ctx.dispose();
    },
  };
  return f;
}

describe("run/rebound 事件（fold）", () => {
  it("parentSession 迁移到 to；其余快照不变", () => {
    const events: readonly WorkflowEvent[] = [
      { type: "run/created", runId: "r", parentSession: "old", cwd: "/w" },
      { type: "task/submitted", taskId: "t", spec: { description: "d", prompt: "p" } },
      { type: "run/rebound", from: "old", to: "new" },
    ];
    const made = fold(events);
    expect(made?.parentSession).toBe("new");
    expect(made?.tasks["t"]?.status).toBe("submitted");
  });
});

describe("会话重绑（期 2-A）", () => {
  it("rebind 后：新会话可提交（submit 门复活）；在飞 run 的 journal/header 迁移", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-rb-"));
    const f = await makeFixture(root, "sess-old");
    await f.loop.create({ session: { id: "sess-old" as SessionId }, agent: { model: "m", provider: "fake" } });
    const denied = await f.submit("sess-new" as SessionId, { description: "d", prompt: "p", result_schema: { type: "object" } });
    expect(denied.ok).toBe(false);

    f.scripts.set("m", [textScript('{"a":1}')]);
    const sent = await f.submit("sess-old" as SessionId, { description: "keep flying", prompt: "x", result_schema: { type: "object" } });
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => expect(f.texts("sess-old")).toContain("workflow-notification"), { timeout: 5_000 });

    const rebound = await f.workflow.rebind("sess-new" as SessionId);
    expect(rebound.ok).toBe(true);

    await f.loop.create({ session: { id: "sess-new" as SessionId }, agent: { model: "m", provider: "fake" } });
    const allowed = await f.submit("sess-new" as SessionId, { description: "after rebind", prompt: "y", result_schema: { type: "object" } });
    expect(allowed.ok).toBe(true);

    const deniedOld = await f.submit("sess-old" as SessionId, { description: "d", prompt: "p", result_schema: { type: "object" } });
    expect(deniedOld.ok).toBe(false);
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  }, 15_000);

  it("悬置通知：死父窗口 settle 后 rebind 即时补投到新会话", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-rb2-"));
    const f = await makeFixture(root, "sess-old");
    const parent = await f.loop.create({ session: { id: "sess-old" as SessionId }, agent: { model: "m", provider: "fake" } });
    if (!parent.ok) throw new Error(parent.reason);
    f.scripts.set("m", [textScript('{"a":1}')]);
    const sent = await f.submit("sess-old" as SessionId, { description: "orphan", prompt: "x", result_schema: { type: "object", required: ["a"] } });
    expect(sent.ok).toBe(true);
    await parent.value.dispose();
    await sleepFor(600);

    await f.loop.create({ session: { id: "sess-new" as SessionId }, agent: { model: "m", provider: "fake" } });
    const rebound = await f.workflow.rebind("sess-new" as SessionId);
    expect(rebound.ok).toBe(true);
    await vi.waitFor(() => expect(f.texts("sess-new")).toContain("workflow-notification"), { timeout: 5_000 });
    const { readdir, readFile } = await import("node:fs/promises");
    const runs = await readdir(join(root, "workflows"));
    let sawRebound = false;
    for (const rid of runs) {
      const j = await readFile(join(root, "workflows", rid, "journal.jsonl"), "utf8").catch(() => "");
      if (j.includes("run/rebound")) {
        sawRebound = true;
        expect(j).toContain("notify/delivered");
      }
    }
    expect(sawRebound).toBe(true);
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  }, 15_000);

  it("幂等：rebind 到同会话 no-op", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-rb3-"));
    const f = await makeFixture(root, "same");
    const noop = await f.workflow.rebind("same" as SessionId);
    expect(noop.ok).toBe(true);
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

describe("在飞 run 的归属迁移（真在飞窗口——非 settled 后）", () => {
  it("submit 后立即 rebind：run/rebound 落账 + journal 归属迁移（A 路假绿裁决补充）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-rb-fly-"));
    const scripts = new Map<string, AsyncGenerator<LlmChunk>[]>();
    scripts.set("task-model", Array.from({ length: 8 }, () => textScript("working ".repeat(50))));
    const ctx = createContext();
    const plugins: readonly Plugin[] = [
      sessionPlugin, toolsPlugin, systemPromptPlugin, llmPlugin, agentLoopPlugin, createTaskToolsPlugin(),
      createAgentDelegationPlugin({ agentsDirs: [], workspaceRoot: root, worktreeSweep: false }),
      createAgentWorkflowPlugin({ userCommandOnly: false, root: join(root, "workflows"), mainSession: "fly-old" as SessionId }),
    ];
    await loadPlugins(ctx, plugins);
    const loop = ctx.use(agentLoopServiceToken);
    const off = ctx.use(llmRuntime).registerAdapter({
      name: "fake",
      stream: async function* (request: import("@x-harness/llm").LlmRequest): AsyncGenerator<LlmChunk> {
        for await (const chunk of scripts.get(request.model)?.shift() ?? textScript("")) yield chunk;
      },
    });
    ctx.effect(off);
    const parent = await loop.create({ session: { id: "fly-old" as SessionId }, agent: { model: "task-model", provider: "fake" } });
    if (!parent.ok) throw new Error(parent.reason);
    const registry = ctx.use(toolRegistry);
    const made = await registry.dispatch({ callId: "fly1", name: "workflow_submit", args: { description: "long work", prompt: "x", result_schema: { type: "object" } }, signal: new AbortController().signal, session: "fly-old" as SessionId });
    expect(made.isError).toBeUndefined();
    await sleep(150);
    const { workflowView } = await import("../plugin.ts");
    const rebound = await ctx.use(workflowView).rebind("fly-new" as SessionId);
    expect(rebound.ok).toBe(true);
    const { readdir, readFile } = await import("node:fs/promises");
    const runs = await readdir(join(root, "workflows"));
    let sawRebound = false;
    for (const rid of runs) {
      const j = await readFile(join(root, "workflows", rid, "journal.jsonl"), "utf8").catch(() => "");
      if (j.includes("run/rebound")) {
        sawRebound = true;
        expect(j).toContain('"to":"fly-new"');
      }
    }
    expect(sawRebound).toBe(true);
    await parent.value.dispose();
    await ctx.dispose();
    await rm(root, { recursive: true, force: true });
  }, 15_000);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});
