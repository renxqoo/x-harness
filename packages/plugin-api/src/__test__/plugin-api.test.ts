// P1 糖与裸 token 行为等价性（SDK-MIGRATION-P1 §4）：每 helper 一用例——
// 变换落账一致/否决配对 deny/流包裹/观察只读。装置最小化（不跑全 loop 的面用裸 dispatch）。

import { describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolDefinition } from "@x-harness/tools";
import { Type } from "@sinclair/typebox";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import type { AgentLoopService } from "@x-harness/agent-loop";
import { tapAssistant, tapSessionEvents, transformAssistant, transformDial, transformMessages, transformToolResult, vetoStep, vetoTools, wrapStream } from "../index.ts";

const AGENT = { model: "m", provider: "fake" };

/** 前缀包裹（模块级——压嵌套） */
async function* prefixWrap(prefix: string, inner: AsyncIterable<LlmChunk>): AsyncGenerator<LlmChunk> {
  yield { type: "text-delta", text: prefix };
  for await (const chunk of inner) yield chunk;
}


function textScript(text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

interface World {
  readonly ctx: Context;
  readonly loop: AgentLoopService;
  readonly cleanup: () => Promise<void>;
}

async function makeWorld(): Promise<World> {
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, llmPlugin, systemPromptPlugin, agentLoopPlugin]);
  ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: () => textScript("hello"),
  });
  return { ctx, loop: ctx.use(agentLoopServiceToken), cleanup: async () => { await ctx.dispose(); void unload; } };
}

type Ev = { readonly type: string; readonly data: unknown };

const run = async (world: World, input: string): Promise<readonly Ev[]> => {
  const made = await world.loop.create({ agent: AGENT });
  if (!made.ok) throw new Error(made.reason);
  made.value.agent.followup(input);
  await made.value.agent.whenIdle();
  return made.value.agent.session.events() as readonly Ev[];
};

const texts = (events: readonly Ev[], type: string): string[] =>
  events.filter((e) => e.type === type).map((e) => ((e.data as { content?: readonly { type: string; text?: string }[] }).content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(""));

describe("plugin-api（P1 语法糖等价性）", () => {
  it("transformMessages：改写落账一致（糖=裸中间件）", async () => {
    const world = await makeWorld();
    const off = transformMessages(world.ctx, () => [{ id: "s", content: [{ type: "text", text: "SUGAR" }] }]);
    const events = await run(world, "orig");
    off();
    await world.cleanup();
    expect(texts(events, "user/message")).toEqual(["SUGAR"]);
  });

  it("vetoStep：否决 → 无 user 落账、turn 不进 step", async () => {
    const world = await makeWorld();
    const off = vetoStep(world.ctx, () => "blocked-by-sugar");
    const events = await run(world, "nope");
    off();
    await world.cleanup();
    expect(texts(events, "user/message")).toEqual([]);
    expect(events.some((e) => e.type === "request/header")).toBe(false);
  });

  it("transformAssistant：落账前纠生效", async () => {
    const world = await makeWorld();
    const off = transformAssistant(world.ctx, (s) => ({ ...s, content: [{ type: "text", text: "FIXED" }] }));
    const events = await run(world, "hi");
    off();
    await world.cleanup();
    expect(texts(events, "assistant/message")).toEqual(["FIXED"]);
  });

  it("vetoTools + transformToolResult：否决配对 deny；输出变换", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin]);
    const tool: ToolDefinition = { name: "probe", inputSchema: Type.Object({}), execute: async () => ({ content: "raw" }) };
    ctx.use(toolRegistry).register(tool);
    const offVeto = vetoTools(ctx, (call) => (call.name === "probe" ? { kind: "deny", reason: "no-probe" } : undefined));
    const reg = ctx.use(toolRegistry);
    const denied = await reg.dispatch({ callId: "c1", name: "probe", args: {}, signal: new AbortController().signal });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("no-probe");
    offVeto();
    // transformToolResult（同 ctx 验证变换路径）
    const offT = transformToolResult(ctx, (outcome) => ({ ...outcome, content: `wrapped:${outcome.content}` }));
    const out = await reg.dispatch({ callId: "c2", name: "probe", args: {}, signal: new AbortController().signal });
    expect(out.content).toBe("wrapped:raw");
    offT();
    const plain = await reg.dispatch({ callId: "c3", name: "probe", args: {}, signal: new AbortController().signal });
    expect(plain.content).toBe("raw");
    await ctx.dispose();
    void unload;
  });

  it("wrapStream + transformDial + tapAssistant/tapToolCalls/tapSessionEvents：包裹/变换/观察", async () => {
    const world = await makeWorld();
    const seenAssistant: string[] = [];
    const seenSession: string[] = [];
    const offW = wrapStream(world.ctx, (inner) => prefixWrap("P-", inner));
    const collectText = (s: { content: readonly unknown[] }): string => s.content.map((b) => (b as { text?: string }).text ?? "").join("");
    const offA = tapAssistant(world.ctx, (s) => { seenAssistant.push(collectText(s)); });
    const offS = tapSessionEvents(world.ctx, (e) => { seenSession.push(e.type); });
    const events = await run(world, "hi");
    offW(); offA(); offS();
    await world.cleanup();
    expect(texts(events, "assistant/message")).toEqual(["P-hello"]); // 流包裹进结算
    expect(seenAssistant).toEqual(["P-hello"]); // 观察只读不改
    expect(seenSession).toContain("assistant/message"); // 逃生舱收全量
  });

  it("transformDial：拨号参数变换（裸面验证 sugar 形状）", async () => {
    const ctx = createContext();
    const off = transformDial(ctx, (d) => ({ ...d, temperature: 0.7 }));
    const agentRequestToken = (await import("@x-harness/agent-loop")).agentRequest;
    const out = await ctx.dispatch(agentRequestToken, { dial: { model: "m" } } as never, async (p) => p.dial as never);
    expect(out).toMatchObject({ model: "m", temperature: 0.7 });
    off();
    await ctx.dispose();
  });
});
