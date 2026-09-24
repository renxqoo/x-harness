// error-recovery 插件集成装置：真装配 session+tools+llm+loop（+可选 llm-retry）+
// 脚本化假适配器——分族升级/总封顶/清零/防预烧/死类直通/respond 落卷与脱敏/收束 resume。

import { createContext, loadPlugins } from "@x-harness/core";
import type { Plugin } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import type { SessionEvent } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import type { Agent, AgentHandle } from "@x-harness/agent-loop";
import { afterEach, expect } from "vitest";

export interface RecoveryWorld {
  ctx: ReturnType<typeof createContext>;
  scripts: Array<AsyncGenerator<LlmChunk>>;
  calls: Array<{ messages: unknown[] }>;
  agent: Agent;
  handle: AgentHandle;
  cleanup: () => Promise<void>;
}

let worlds: RecoveryWorld[] = [];
afterEach(async () => {
  for (const world of worlds) await world.cleanup().catch(() => {});
  worlds = [];
});
export const resetRecoveryWorlds = (): void => {
  worlds = [];
};

/** 脚本耗尽后兜底：error E_EXHAUSTED（防「静默成功」干扰计数断言） */
function fallbackScript(): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "finish", finish: { kind: "error", message: "exhausted", code: "E_EXHAUSTED" } };
  })();
}

export async function makeRecoveryWorld(extra: readonly Plugin[]): Promise<RecoveryWorld> {
  const ctx = createContext();
  const scripts: Array<AsyncGenerator<LlmChunk>> = [];
  const calls: Array<{ messages: unknown[] }> = [];
  const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, llmPlugin, systemPromptPlugin, agentLoopPlugin, ...extra]);
  ctx.effect(() => { for (const off of unload) off(); });
  const off = ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: (request) => {
      calls.push({ messages: request.messages as unknown[] });
      return scripts.shift() ?? fallbackScript();
    },
  });
  ctx.effect(off);
  const made = await ctx.use(agentLoopServiceToken).create({ agent: { model: "m", provider: "fake" } });
  expect(made.ok).toBe(true);
  if (!made.ok) throw new Error(made.reason);
  const world: RecoveryWorld = {
    ctx,
    scripts,
    calls,
    agent: made.value.agent,
    handle: made.value,
    cleanup: async () => {
      await made.value.dispose();
      await ctx.dispose();
    },
  };
  worlds.push(world);
  return world;
}

export function errorFinish(message: string, code?: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "finish", finish: { kind: "error", message, ...(code !== undefined ? { code } : {}) } };
  })();
}

export function textFinish(text = "ok"): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

export const turnEnd = (events: readonly SessionEvent[]): SessionEvent | undefined => events.at(-1);
