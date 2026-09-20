// 驱动测试共享装置：真实装配 session+tools+llm+system-prompt + 脚本化假适配器世界
// （未写脚本时兜底文本——不静默空转）；世界登记与 afterEach 清理集中于此。

import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { SessionEvent, SessionStore } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolRegistry } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "../index.ts";
import type { Agent, AgentHandle, AgentLoopService } from "../index.ts";
import { afterEach, expect } from "vitest";

/** 脚本化假适配器：每次调用弹出一段脚本 */
export function fakeAdapter(): { scripts: Array<AsyncGenerator<LlmChunk> | ((request: LlmRequest) => AsyncGenerator<LlmChunk>)>; calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const scripts: Array<AsyncGenerator<LlmChunk> | ((request: LlmRequest) => AsyncGenerator<LlmChunk>)> = [];
  return {
    calls,
    scripts,
  };
}

export function textScript(text: string, finish: "stop" | "max-tokens" = "stop"): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "usage", usage: { input: 1, output: 2 } };
    yield { type: "finish", finish: { kind: finish } };
  })();
}

export function toolScript(callId: string, name: string, args: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "tool-call-delta", index: 0, callId, name, argumentsDelta: args };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

export function errorScript(message: string, code?: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "finish", finish: { kind: "error", message, code } };
  })();
}

export interface World {
  ctx: Context;
  loop: AgentLoopService;
  store: SessionStore;
  tools: ToolRegistry;
  fake: ReturnType<typeof fakeAdapter>;
  cleanup: () => Promise<void>;
}

export async function makeWorld(): Promise<World> {
  const ctx = createContext();
  const fake = fakeAdapter();
  const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, llmPlugin, systemPromptPlugin, agentLoopPlugin]);
  const off = ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: (request) => {
      fake.calls.push(request);
      const next = fake.scripts.shift();
      if (next === undefined) return textScript("(no script)");
      return typeof next === "function" ? next(request) : next;
    },
  });
  ctx.effect(off);
  return {
    ctx,
    loop: ctx.use(agentLoopServiceToken),
    store: ctx.use(sessionStore),
    tools: ctx.use(toolRegistry),
    fake,
    cleanup: async () => {
      await ctx.dispose();
      void unload;
    },
  };
}

export const AGENT = { model: "fake-model", provider: "fake" };

export let worlds: World[] = [];

export function resetWorlds(): void {
  worlds = [];
}

afterEach(async () => {
  for (const world of worlds) await world.cleanup().catch(() => {});
});

export async function spawn(world: World): Promise<{ handle: AgentHandle; agent: Agent }> {
  const made = await world.loop.create({ agent: AGENT });
  expect(made.ok).toBe(true);
  if (!made.ok) throw new Error(made.reason);
  return { handle: made.value, agent: made.value.agent };
}

export const types = (agent: Agent): string[] => agent.session.events().map((event: SessionEvent) => event.type);
