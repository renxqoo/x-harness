// agentLoop 插件（docs/AGENT-LOOP-DRIVER.md §1.1）：create/resume 工厂；每 agent 一个 scope 层。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import type { Result } from "@x-harness/core";
import { defineService, errorText } from "@x-harness/core";
import { llmRuntime } from "@x-harness/llm";
import type { SessionArchive, SessionStore } from "@x-harness/session";
import { sessionArchive, sessionStore } from "@x-harness/session";
import { systemPrompt } from "@x-harness/system-prompt";
import { toolRegistry } from "@x-harness/tools";
import { createDriver } from "./driver.ts";
import type { ResolvedOptions } from "./driver.ts";
import { interruptedTurnClosers } from "./repair.ts";
import {
  agentAssistantStream,
  agentError,
  agentPreStep,
  agentRequest,
  agentRequestError,
  agentStatus,
  agentTurnStopping,
} from "./tokens.ts";
import type { Agent, AgentHandle, AgentLoopService, AgentOptions, CreateAgentOptions, ResumeAgentOptions } from "./types.ts";

const DEFAULT_MAX_PARALLEL = 10;
const DEFAULT_MAX_RESULT_CHARS = 100_000;

export const agentLoopServiceToken = defineService<AgentLoopService>("agent-loop");

function resolveOptions(options: AgentOptions | undefined): ResolvedOptions {
  return {
    ...options,
    maxParallelToolCalls: options?.maxParallelToolCalls ?? DEFAULT_MAX_PARALLEL,
    maxToolResultChars: options?.maxToolResultChars ?? DEFAULT_MAX_RESULT_CHARS,
  };
}

export const agentLoopPlugin = {
  name: "agent-loop",
  inject: ["session", "llm", "tools", "system-prompt"],
  apply: (ctx: Context): Disposer => {
    const store = ctx.use(sessionStore);
    const llm = ctx.use(llmRuntime);
    const tools = ctx.use(toolRegistry);
    const prompt = ctx.use(systemPrompt);

    const spawn = async (session: Awaited<ReturnType<SessionStore["create"]>> extends infer R ? (R extends { ok: true; value: infer S } ? S : never) : never, agentScope: Context, options: ResolvedOptions): Promise<AgentHandle> => {
      const driver = createDriver({
        session,
        options,
        llm,
        tools,
        prompt,
        emitStatus: (status) => {
          agentScope.emit(agentStatus, { session: session.id, status });
        },
        emitError: (turn, message) => {
          agentScope.emit(agentError, { session: session.id, turn, message });
        },
        emitStreamFrame: (turn, step, frame) => {
          agentScope.emit(agentAssistantStream, { session: session.id, turn, step, frame: frame as never });
        },
        dispatchPreStep: (payload) =>
          agentScope.dispatch(agentPreStep, payload as never, async () => ({ kind: "enter" }) as never),
        dispatchRequest: (payload, dial) => agentScope.dispatch(agentRequest, payload as never, async () => dial),
        dispatchRequestError: (payload) =>
          agentScope.dispatch(agentRequestError, payload as never, async () => undefined),
        dispatchTurnStopping: (payload) => agentScope.dispatch(agentTurnStopping, payload as never),
      });
      const agent: Agent = {
        session,
        options,
        get status() {
          return driver.status();
        },
        followup: driver.followup,
        steer: driver.steer,
        inject: driver.inject,
        cancel: driver.cancel,
        whenIdle: driver.whenIdle,
      };
      return {
        agent,
        dispose: async () => {
          driver.cancel("disposed");
          await driver.whenIdle();
          await agentScope.dispose();
          store.dispose(session.id); // 封存写权：append 此后 session-disposed；持久化层 drain-then-close
        },
      };
    };

    const create = async (options: CreateAgentOptions = {}): Promise<Result<AgentHandle>> => {
      const made = await store.create(options.session);
      if (!made.ok) return { ok: false, reason: made.reason };
      const session = made.value;
      const agentScope = ctx.scope({ agentId: `agent:${session.id}` });
      try {
        const handle = await spawn(session as never, agentScope, resolveOptions(options.agent));
        return { ok: true, value: handle };
      } catch (error) {
        await agentScope.dispose().catch(() => {});
        store.dispose(session.id); // 失败不留可写会话在 store
        return { ok: false, reason: `spawn-failed:${errorText(error)}` };
      }
    };

    const resume = async (options: ResumeAgentOptions): Promise<Result<AgentHandle>> => {
      const archive = ctx.tryUse(sessionArchive) as SessionArchive | undefined;
      if (archive === undefined) return { ok: false, reason: "no-session-archive" };
      const read = await archive.read(options.id);
      if (!read.ok) return { ok: false, reason: read.reason };
      const closers = interruptedTurnClosers(read.value.events);
      const made = await store.create({
        header: read.value.header,
        seed: [...read.value.events, ...closers],
      });
      if (!made.ok) return { ok: false, reason: made.reason };
      const agentScope = ctx.scope({ agentId: `agent:${made.value.id}` });
      try {
        const handle = await spawn(made.value as never, agentScope, resolveOptions(options.agent));
        return { ok: true, value: handle };
      } catch (error) {
        await agentScope.dispose().catch(() => {});
        store.dispose(made.value.id); // 失败不留可写会话在 store
        return { ok: false, reason: `spawn-failed:${errorText(error)}` };
      }
    };

    const service: AgentLoopService = { create, resume };
    return ctx.provide(agentLoopServiceToken, service);
  },
} satisfies Plugin;
