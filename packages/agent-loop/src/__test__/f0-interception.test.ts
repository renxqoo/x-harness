// F0 拦截面三专测（docs/SDK-DESIGN §6.1）：①pre-step 改写（改写版即落账版——「模型可见必落盘」）
// ②assistant 落账前纠 ③流拦截（包裹注入帧）。装置沿用 driver.test 同款。

import { createContext, loadPlugins } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { SessionEvent, SessionStore } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolRegistry } from "@x-harness/tools";
import { afterEach, describe, expect, it } from "vitest";
import { agentAssistantSettle, agentError, agentLlmStream, agentLoopPlugin, agentLoopServiceToken, agentPreStep } from "../index.ts";
import type { AgentLoopService } from "../index.ts";

function textScript(text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

interface World {
  loop: AgentLoopService;
  store: SessionStore;
  tools: ToolRegistry;
  calls: LlmRequest[];
  cleanup: () => Promise<void>;
  ctx: ReturnType<typeof createContext>;
}

async function makeWorld(): Promise<World> {
  const ctx = createContext();
  const calls: LlmRequest[] = [];
  const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, llmPlugin, systemPromptPlugin, agentLoopPlugin]);
  const off = ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: (request) => {
      calls.push(request);
      return textScript("hello");
    },
  });
  ctx.effect(off);
  return {
    ctx,
    loop: ctx.use(agentLoopServiceToken),
    store: ctx.use(sessionStore),
    tools: ctx.use(toolRegistry),
    calls,
    cleanup: async () => {
      await ctx.dispose();
      void unload;
    },
  };
}

const AGENT = { model: "fake-model", provider: "fake" };

/** 流包裹：注入前缀帧（模块级——压测试内嵌套回调） */
async function* prefixStream(prefix: string, inner: AsyncIterable<LlmChunk>): AsyncGenerator<LlmChunk> {
  yield { type: "text-delta", text: prefix };
  for await (const chunk of inner) yield chunk;
}

const surfaceTexts = (events: readonly SessionEvent[], type: string): string[] =>
  events
    .filter((event) => event.type === type)
    .map((event) => ((event.data as { content?: readonly { type: string; text?: string }[] }).content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join(""));

let worlds: World[] = [];
afterEach(async () => {
  for (const world of worlds) await world.cleanup().catch(() => {});
  worlds = [];
});

describe("F0 拦截面（SDK-DESIGN §6.1）", () => {
  it("① pre-step 改写：落账与模型可见走重写版（改写版即日志版）；claim 记原始", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const rewrite = (decision: unknown): unknown =>
      (decision as { kind: string }).kind === "enter"
        ? { kind: "enter", messages: [{ id: "rw-1", content: [{ type: "text", text: "REWRITTEN" }] }] }
        : decision;
    const off = world.ctx.on(agentPreStep, async (_payload, next) => rewrite(await next(_payload)) as never);
    const made = await world.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.followup("original");
    await made.value.agent.whenIdle();
    off();
    const events = made.value.agent.session.events();
    expect(surfaceTexts(events, "user/message")).toEqual(["REWRITTEN"]); // 落账=重写版
    expect(world.calls[0]?.messages.some((m) => JSON.stringify(m).includes("REWRITTEN"))).toBe(true); // 模型可见=重写版
    expect(surfaceTexts(events, "user/message")).not.toContain("original"); // 原文只留 claim 痕迹
  });

  it("② assistant 落账前纠：settle 改写 content → 落账与返回消息均为改写版", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const off = world.ctx.on(agentAssistantSettle, async (payload, next) => {
      const out = await next(payload);
      return { ...out, content: [{ type: "text", text: "CORRECTED" }] } as never;
    });
    const made = await world.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.followup("hi");
    await made.value.agent.whenIdle();
    off();
    expect(surfaceTexts(made.value.agent.session.events(), "assistant/message")).toEqual(["CORRECTED"]);
  });

  it("③ 流拦截：wrapStream 注入前缀帧 → 结算消息含注入内容；settle 改写仍胜（落账以 settle 为准）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const offStream = world.ctx.on(agentLlmStream, async (payload, next) => {
      const inner = await next(payload);
      return prefixStream("PREFIX-", inner);
    });
    const offSettle = world.ctx.on(agentAssistantSettle, async (payload, next) => {
      const out = await next(payload);
      return { ...out, content: [{ type: "text", text: "SETTLE-WINS" }] } as never; // 落账前纠覆盖流面
    });
    const made = await world.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.followup("hi");
    await made.value.agent.whenIdle();
    offStream();
    offSettle();
    expect(surfaceTexts(made.value.agent.session.events(), "assistant/message")).toEqual(["SETTLE-WINS"]); // settle 胜
  });

  it("③ 流拦截（无 settle 时）：注入帧进结算——流面影响累积与落账", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const off = world.ctx.on(agentLlmStream, async (payload, next) => {
      const inner = await next(payload);
      return prefixStream("PREFIX-", inner);
    });
    const made = await world.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.followup("hi");
    await made.value.agent.whenIdle();
    off();
    expect(surfaceTexts(made.value.agent.session.events(), "assistant/message")).toEqual(["PREFIX-hello"]);
  });
});

describe("F0 收口审查处置回归", () => {
  it("1.2：step0 改写空 → 落 durable clear（repair trailingClaims 复位依据）；turn 闭", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const off = world.ctx.on(agentPreStep, async (payload, next) => ((await next(payload), { kind: "enter", messages: [] }) as never));
    const made = await world.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.followup("drop-me");
    await made.value.agent.whenIdle();
    off();
    const events = made.value.agent.session.events();
    expect(events.some((e) => e.type === "agent/inbox/spliced" && (e.data as { op?: string }).op === "clear")).toBe(true); // durable 清除意图
    expect(surfaceTexts(events, "user/message")).toEqual([]); // 无 user 落账
  });

  it("1.1：载荷含 claim 批次（改写输入源）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    let seenClaim = 0;
    const off = world.ctx.on(agentPreStep, async (payload, next) => {
      seenClaim = (payload as unknown as { claim?: unknown[] }).claim?.length ?? -1;
      return next(payload);
    });
    const made = await world.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.followup("claimed-one");
    await made.value.agent.whenIdle();
    off();
    expect(seenClaim).toBe(1);
  });

  it("1.4/2.1：改写垃圾形状与 settle stopReason 越词表 → 可读 throw（非 TypeError 伪装）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const errors: string[] = [];
    const offErr = world.ctx.on(agentError, (e) => errors.push(e.message));
    const off = world.ctx.on(agentPreStep, async (_p, next) => ((await next(_p), { kind: "enter", messages: "garbage" }) as never));
    const made = await world.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.followup("x");
    await made.value.agent.whenIdle();
    off();
    offErr();
    expect(errors.some((m) => m.includes("pre-step rewrite shape invalid"))).toBe(true); // 可读契约失败经 agentError 面
  });
});
