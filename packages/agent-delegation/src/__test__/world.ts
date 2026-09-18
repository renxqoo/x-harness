// 子代理测试共享装置：按 model 分桶的假适配器世界（未注册 model 报错——防串线静默假绿）。

import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolRegistry } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import type { AgentHandle, AgentLoopService } from "@x-harness/agent-loop";
import { createAgentDelegationPlugin } from "../plugin.ts";
import type { DelegationOptions } from "../types.ts";
import { afterEach, expect } from "vitest";

export const PARENT_MODEL = "parent-model";
export const CHILD_MODEL = "child-model";

export const OPTIONS: DelegationOptions = {
  types: { worker: { model: CHILD_MODEL, prompt: "you are a worker" } },
};

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

export function resetWorlds(): void {
  worlds = [];
}

afterEach(async () => {
  for (const world of worlds) await world.cleanup().catch(() => {});
});

export async function makeWorld(options: DelegationOptions): Promise<World> {
  const ctx = createContext();
  const scripts = new Map<string, Array<AsyncGenerator<LlmChunk>>>();
  const calls: LlmRequest[] = [];
  const delegation = createAgentDelegationPlugin(options);
  const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, llmPlugin, systemPromptPlugin, agentLoopPlugin, delegation]);
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

export async function spawnParent(world: World, model = PARENT_MODEL): Promise<AgentHandle> {
  const made = await world.loop.create({ agent: { model, provider: "fake" } });
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
