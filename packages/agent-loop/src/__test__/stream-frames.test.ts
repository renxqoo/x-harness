// 流式帧广播全链（docs/THINKING-STREAM.md）：真实装配 + 脚本化假适配器；
// 帧断言装置必须先于 followup 订阅（事件即发即弃无重放，订晚收空数组）。

import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import type { SessionEvent } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { Type } from "@sinclair/typebox";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolRegistry } from "@x-harness/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentAssistantStream, agentLoopPlugin, agentLoopServiceToken, agentRequestError } from "../index.ts";
import type { Agent, AgentHandle, AgentLoopService, AssistantStreamFrame } from "../index.ts";

function textScript(text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

interface FrameWorld {
  ctx: Context;
  loop: AgentLoopService;
  tools: ToolRegistry;
  fake: { scripts: Array<AsyncGenerator<LlmChunk>>; calls: LlmRequest[] };
  cleanup: () => Promise<void>;
}

async function makeFrameWorld(): Promise<FrameWorld> {
  const ctx = createContext();
  const fake = { scripts: [] as Array<AsyncGenerator<LlmChunk>>, calls: [] as LlmRequest[] };
  const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, llmPlugin, systemPromptPlugin, agentLoopPlugin]);
  const off = ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: (request) => {
      fake.calls.push(request);
      return fake.scripts.shift() ?? textScript("(no script)");
    },
  });
  ctx.effect(off);
  return {
    ctx,
    loop: ctx.use(agentLoopServiceToken),
    tools: ctx.use(toolRegistry),
    fake,
    cleanup: async () => {
      await ctx.dispose();
      void unload;
    },
  };
}

const AGENT = { model: "fake-model", provider: "fake" };

let worlds: FrameWorld[] = [];
afterEach(async () => {
  for (const world of worlds) await world.cleanup().catch(() => {});
  worlds = [];
});

async function spawn(world: FrameWorld): Promise<{ handle: AgentHandle; agent: Agent }> {
  const made = await world.loop.create({ agent: AGENT });
  expect(made.ok).toBe(true);
  if (!made.ok) throw new Error(made.reason);
  return { handle: made.value, agent: made.value.agent };
}

/** 帧收集：必须先于 followup 订阅——事件即发即弃无重放，订晚收空数组 */
function collectFrames(world: FrameWorld): { frames: AssistantStreamFrame[]; off: () => void } {
  const frames: AssistantStreamFrame[] = [];
  const off = world.ctx.on(agentAssistantStream, (payload: { frame: AssistantStreamFrame }) => {
    frames.push(payload.frame);
  });
  return { frames, off };
}

describe("流式帧广播（docs/THINKING-STREAM.md）", () => {
  it("帧序列整锁：start→thinking/text 交错→end；tool-call/usage 零帧；思考不落账不回传（哨兵）", async () => {
    const world = await makeFrameWorld();
    worlds.push(world);
    world.tools.register({ name: "t", inputSchema: Type.Object({}), execute: async () => ({ content: "1" }) });
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "thinking-delta", text: "THINK-SENTINEL" };
        yield { type: "text-delta", text: "a" };
        yield { type: "thinking-delta", text: "more" };
        yield { type: "tool-call-delta", index: 0, callId: "c1", name: "t", argumentsDelta: "{}" };
        yield { type: "text-delta", text: "b" };
        yield { type: "usage", usage: { input: 1, output: 2 } };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    );
    world.fake.scripts.push(textScript("done"));
    const { agent, handle } = await spawn(world);
    const { frames, off } = collectFrames(world);
    agent.followup("hi");
    await agent.whenIdle();
    off();
    expect(frames).toEqual([
      { phase: "start" },
      { phase: "chunk", kind: "thinking", text: "THINK-SENTINEL" },
      { phase: "chunk", kind: "text", text: "a" },
      { phase: "chunk", kind: "thinking", text: "more" },
      { phase: "chunk", kind: "text", text: "b" },
      { phase: "end", kind: "message" },
      { phase: "start" }, // 第二步消化工具结果
      { phase: "chunk", kind: "text", text: "done" },
      { phase: "end", kind: "message" },
    ]);
    // 落账与回传零泄漏：session 事件、第二次请求体均不含思考哨兵
    expect(JSON.stringify(agent.session.events().map((e: SessionEvent) => e.data))).not.toContain("THINK-SENTINEL");
    expect(JSON.stringify(world.fake.calls[1]?.messages)).not.toContain("THINK-SENTINEL");
    const assistants = agent.session.events().filter((e) => e.type === "assistant/message");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.data).toMatchObject({
      content: [
        { type: "text", text: "ab" },
        { type: "tool_use", callId: "c1", name: "t", input: "{}" },
      ],
    });
    expect(assistants[1]?.data).toMatchObject({ content: [{ type: "text", text: "done" }] });
    await handle.dispose();
  });

  it("attempt 边界：失败尝试 end{attempt} → 重试再 start——两段思考不粘连、帧序完整", async () => {
    const world = await makeFrameWorld();
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    let retried = 0;
    const offRetry = world.ctx.on(
      agentRequestError,
      async (payload: unknown, next: (input: unknown) => Promise<unknown>): Promise<{ kind: "retry" } | undefined> => {
        await next(payload);
        retried += 1;
        return retried <= 1 ? { kind: "retry" } : undefined;
      },
    );
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "thinking-delta", text: "first-thought" };
        yield { type: "finish", finish: { kind: "error", message: "E1" } };
      })(),
    );
    world.fake.scripts.push(textScript("ok"));
    const { frames, off } = collectFrames(world);
    agent.followup("hi");
    await agent.whenIdle();
    offRetry();
    off();
    expect(frames).toEqual([
      { phase: "start" },
      { phase: "chunk", kind: "thinking", text: "first-thought" },
      { phase: "end", kind: "attempt" },
      { phase: "start" },
      { phase: "chunk", kind: "text", text: "ok" },
      { phase: "end", kind: "message" },
    ]);
    expect(JSON.stringify(agent.session.events().map((e: SessionEvent) => e.data))).not.toContain("first-thought");
    await handle.dispose();
  });

  it("abort 变种：thinking-only → attempt 终态不产消息；thinking+text → interrupted 消息只含 text", async () => {
    // (a) thinking-only + abort：思考不算 content → 空结算 attempt，无 assistant/message
    const worldA = await makeFrameWorld();
    worlds.push(worldA);
    worldA.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "thinking-delta", text: "hmm" };
        await new Promise(() => {}); // 悬停流
      })(),
    );
    const madeA = await spawn(worldA);
    const collectedA = collectFrames(worldA);
    madeA.agent.followup("hi");
    await vi.waitFor(() => expect(worldA.fake.calls.length).toBe(1));
    madeA.agent.cancel("user");
    await madeA.agent.whenIdle();
    collectedA.off();
    expect(collectedA.frames).toEqual([
      { phase: "start" },
      { phase: "chunk", kind: "thinking", text: "hmm" },
      { phase: "end", kind: "attempt" },
    ]);
    expect(madeA.agent.session.events().some((e: SessionEvent) => e.type === "assistant/message")).toBe(false);
    expect(madeA.agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "aborted", cause: "user" } });
    await madeA.handle.dispose();

    // (b) thinking+text 部分 + abort：interrupted 消息，content 只含 text
    const worldB = await makeFrameWorld();
    worlds.push(worldB);
    worldB.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "thinking-delta", text: "hmm" };
        yield { type: "text-delta", text: "partial" };
        await new Promise(() => {}); // 悬停流
      })(),
    );
    const madeB = await spawn(worldB);
    const collectedB = collectFrames(worldB);
    madeB.agent.followup("hi");
    await vi.waitFor(() => expect(worldB.fake.calls.length).toBe(1));
    madeB.agent.cancel("user");
    await madeB.agent.whenIdle();
    collectedB.off();
    expect(collectedB.frames).toEqual([
      { phase: "start" },
      { phase: "chunk", kind: "thinking", text: "hmm" },
      { phase: "chunk", kind: "text", text: "partial" },
      { phase: "end", kind: "message" },
    ]);
    const assistant = madeB.agent.session.events().find((e) => e.type === "assistant/message");
    expect(assistant?.data).toMatchObject({ interrupted: true, content: [{ type: "text", text: "partial" }] });
    await madeB.handle.dispose();
  });
});
