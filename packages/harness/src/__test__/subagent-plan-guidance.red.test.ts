import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Context, Plugin } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolRegistry } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import type { AgentLoopService } from "@x-harness/agent-loop";
import { createPermissionPlugin, permissionBroker } from "@x-harness/permission";
import { createAgentDelegationPlugin } from "@x-harness/agent-delegation";
import { mintSessionId } from "@x-harness/session";
import { createPlanSubmitPlugin } from "@x-harness/tool-plan";
import { createTaskToolsPlugin } from "@x-harness/task-tools";
import { createFactsSnapshotPlugin } from "../snapshot-facts.ts";

function textsOf(session: { events: () => readonly unknown[] }): string[] {
  const out: string[] = [];
  for (const raw of session.events()) {
    const event = raw as { type: string; data: unknown };
    if (event.type !== "user/message") continue;
    const content = (event.data as unknown as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
    for (const block of content) {
      if (block.type === "text" && block.text !== undefined) out.push(block.text);
    }
  }
  return out;
}

function textScript(text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "usage", usage: { input: 1, output: 2 } };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

interface RedWorld {
  readonly ctx: Context;
  readonly loop: AgentLoopService;
  readonly registry: ToolRegistry;
  readonly scripts: Map<string, Array<AsyncGenerator<LlmChunk>>>;
  readonly cleanup: () => Promise<void>;
}

const PARENT_SESSION = mintSessionId() as never;

async function makeWorld(mode: string): Promise<{ world: RedWorld; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "xh-red-"));
  const ctx = createContext();
  const scripts = new Map<string, Array<AsyncGenerator<LlmChunk>>>();
  const brokerPlugin: Plugin = {
    name: "red-broker",
    apply: (c) => c.provide(permissionBroker, { ask: async () => ({ verdict: "allow" as const }) }),
  };
  const plugins: readonly Plugin[] = [
    sessionPlugin,
    toolsPlugin,
    llmPlugin,
    systemPromptPlugin,
    agentLoopPlugin,
    createTaskToolsPlugin(),
    createPermissionPlugin({ root, mode }),
    createPlanSubmitPlugin({ liftTo: "auto", mainSession: PARENT_SESSION }),
    brokerPlugin,
    createAgentDelegationPlugin({ agentsDirs: [], workspaceRoot: root, worktreeSweep: false }),
    createFactsSnapshotPlugin({ cwd: root, now: () => Date.UTC(2026, 8, 27), onWarn: () => {} }),
  ];
  const unload = await loadPlugins(ctx, plugins);
  const off = ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: (request: LlmRequest) => {
      const bucket = scripts.get(request.model);
      const next = bucket?.shift();
      return next ?? textScript("(no script)");
    },
  });
  ctx.effect(off);
  return {
    world: {
      ctx,
      loop: ctx.use(agentLoopServiceToken),
      registry: ctx.use(toolRegistry),
      scripts,
      cleanup: async () => {
        await ctx.dispose();
        void unload;
      },
    },
    root,
  };
}

const PLAN_GUIDANCE = "You are in plan mode";

interface Rig {
  readonly world: RedWorld;
  readonly root: string;
  readonly parentSession: SessionId;
  readonly childSession: SessionId;
}

async function rigPlanSubagent(mode = "plan"): Promise<Rig> {
  const { world, root } = await makeWorld(mode);
  world.scripts.set("pm", [textScript("ok"), textScript("ok")]);
  world.scripts.set("cm", [textScript("sub done"), textScript("sub done")]);
  const made = await world.loop.create({ session: { id: PARENT_SESSION }, agent: { model: "pm", provider: "fake" } });
  expect(made.ok).toBe(true);
  if (!made.ok) throw new Error(made.reason);
  const parentSession = made.value.agent.session.id;
  if (parentSession !== PARENT_SESSION) throw new Error("parent session id mismatch (owner anchor broken)");
  made.value.agent.followup("hi");
  await made.value.agent.whenIdle();
  const spawned = await world.registry.dispatch({
    callId: "red-spawn",
    name: "agent_spawn",
    args: { description: "research the repo state", prompt: "do the research task and report", model: "cm" },
    signal: new AbortController().signal,
    session: parentSession,
  });
  expect(spawned.isError).toBeUndefined();
  if (spawned.isError) throw new Error(spawned.content);
  const hit = spawned.content.match(/session ([A-Za-z0-9._-]+)/);
  if (hit === null) throw new Error(`no session id in spawn text: ${spawned.content}`);
  const childSession = hit[1] as SessionId;
  const child = world.loop.get(childSession);
  if (child === undefined) throw new Error("child handle missing");
  await child.agent.whenIdle();
  return { world, root, parentSession, childSession };
}

let worlds: RedWorld[] = [];
let roots: string[] = [];
afterEach(async () => {
  for (const world of worlds) await world.cleanup().catch(() => {});
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  worlds = [];
  roots = [];
});

describe("权限档快照 × 委派子代理（红测）", () => {
  it("plan 档行为指引不得注入子代理会话——子代理无用户语境（「wait for the user's approval」指引命其等待不存在的批准方）", async () => {
    const rig = await rigPlanSubagent();
    worlds.push(rig.world);
    roots.push(rig.root);
    const parent = rig.world.loop.get(rig.parentSession);
    const child = rig.world.loop.get(rig.childSession);
    if (parent === undefined || child === undefined) throw new Error("handle missing");

    expect(textsOf(parent.agent.session).some((t) => t.includes(PLAN_GUIDANCE))).toBe(true);

    const childGuidance = textsOf(child.agent.session).filter((t) => t.includes(PLAN_GUIDANCE));
    expect(childGuidance).toHaveLength(0);
  });
});
