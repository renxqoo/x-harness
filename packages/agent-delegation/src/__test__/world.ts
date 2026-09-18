// 子代理测试共享装置：按 model 分桶的假适配器世界（未注册 model 报错——防串线静默假绿）。
// 类型经临时 .md 目录种入（U4：类型唯一来源 = 文件）。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { AgentHandle, AgentLoopService } from "@x-harness/agent-loop";
import { createMailboxPlugin } from "@x-harness/session-mailbox";
import { createAgentDelegationPlugin } from "../plugin.ts";
import type { DelegationOptions } from "../types.ts";
import { afterEach, expect } from "vitest";

export const PARENT_MODEL = "parent-model";
export const CHILD_MODEL = "child-model";
export const AGENT_ID = /agent-[0-9a-f]{8}/;

export interface TypeSpec {
  readonly model?: string;
  readonly provider?: string;
  readonly tools?: readonly string[];
  /** 正文 = 子 system prompt */
  readonly body?: string;
}

/** 把类型规格写成临时 .md 目录（每个 makeOptions 独立目录，afterEach 清理） */
export async function makeOptions(types: Record<string, TypeSpec>, over: Partial<DelegationOptions> = {}): Promise<DelegationOptions> {
  const dir = await mkdtemp(join(tmpdir(), "xh-agents-"));
  dirs = [...dirs, dir];
  for (const [name, spec] of Object.entries(types)) {
    const fields = [`name: ${name}`, `description: test type ${name}`];
    if (spec.model !== undefined) fields.push(`model: ${spec.model}`);
    if (spec.provider !== undefined) fields.push(`provider: ${spec.provider}`);
    if (spec.tools !== undefined) fields.push(`tools: ${spec.tools.join(", ")}`);
    await writeFile(join(dir, `${name}.md`), `---\n${fields.join("\n")}\n---\n${spec.body ?? ""}`);
  }
  // 测试装置默认关启动清扫（防装置互扫真仓共享目录——审查 A-P1-2）；直测走 sweepWorktrees
  return { agentsDirs: [dir], worktreeSweep: false, ...over };
}

export const workerOptions = (): Promise<DelegationOptions> => makeOptions({ worker: { model: CHILD_MODEL, body: "you are a worker" } });

export interface World {
  readonly ctx: Context;
  readonly loop: AgentLoopService;
  readonly registry: ToolRegistry;
  readonly scripts: Map<string, Array<AsyncGenerator<LlmChunk>>>;
  readonly calls: LlmRequest[];
  readonly cleanup: () => Promise<void>;
  readonly disposePlugins: () => Promise<void>;
}

let worlds: World[] = [];
let dirs: string[] = [];

export function resetWorlds(): void {
  worlds = [];
}

afterEach(async () => {
  for (const world of worlds) await world.cleanup().catch(() => {});
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});

export async function makeWorld(options: DelegationOptions, mailboxRoot?: string, extraPlugins: readonly Plugin[] = []): Promise<World> {
  const ctx = createContext();
  const scripts = new Map<string, Array<AsyncGenerator<LlmChunk>>>();
  const calls: LlmRequest[] = [];
  const delegation = createAgentDelegationPlugin(options);
  const base = [sessionPlugin, toolsPlugin, llmPlugin, systemPromptPlugin, agentLoopPlugin, ...extraPlugins];
  const plugins = options.mailbox !== undefined && mailboxRoot !== undefined
    ? [
        ...base,
        createMailboxPlugin({ root: mailboxRoot, timing: { pollIntervalMs: 20, heartbeatMs: 5_000, graceMs: 30_000, staleMs: 7 * 24 * 3_600_000, now: () => Date.now() } }),
        delegation,
      ]
    : [...base, delegation];
  const unload = await loadPlugins(ctx, plugins);
  const off = ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: (request) => {
      calls.push(request);
      const bucket = scripts.get(request.model);
      if (bucket === undefined) return errorStream(`no-script-bucket:${request.model}`);
      const next = bucket.shift();
      return next === undefined ? errorStream(`bucket-empty:${request.model}`) : next;
    },
  });
  ctx.effect(off);
  const world: World = {
    ctx,
    loop: ctx.use(agentLoopServiceToken),
    registry: ctx.use(toolRegistry),
    scripts,
    calls,
    cleanup: async () => {
      await ctx.dispose();
      void unload;
    },
    disposePlugins: async () => {
      await ctx.dispose();
    },
  };
  worlds = [...worlds, world];
  return world;
}

export function errorStream(text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "finish", finish: { kind: "error", message: text, code: "test-no-script" } };
  })();
}

export function textScript(_model: string, text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

export async function spawnParent(world: World, model = PARENT_MODEL, id?: SessionId): Promise<AgentHandle> {
  const made = await world.loop.create({ ...(id !== undefined ? { session: { id } } : {}), agent: { model, provider: "fake" } });
  expect(made.ok).toBe(true);
  if (!made.ok) throw new Error(made.reason);
  return made.value;
}

export async function callTool(input: { readonly world: World; readonly name: string; readonly args: unknown; readonly session: SessionId }): Promise<{ content: string; isError?: true }> {
  return input.world.registry.dispatch({
    callId: `t-${String(Math.random()).slice(2, 8)}`,
    name: input.name,
    args: input.args,
    signal: new AbortController().signal,
    session: input.session,
  });
}

export const typesOf = (handle: AgentHandle): string[] => handle.agent.session.events().map((e: { type: string }) => e.type);

export const agentIdOf = (spawnText: string): string => {
  const hit = spawnText.match(AGENT_ID);
  if (hit === null) throw new Error(`no agentId in: ${spawnText}`);
  return hit[0];
};

export const sessionOf = (spawnText: string): SessionId => {
  const hit = spawnText.match(/session ([A-Za-z0-9._-]+)/);
  if (hit === null) throw new Error(`no session in: ${spawnText}`);
  return hit[1] as SessionId;
};
