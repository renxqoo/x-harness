// 插件全链集成（真装配：session+tools+llm+system-prompt+agent-loop+本插件；脚本化假适配器）
// ——docs/OUTPUT-TOKEN-CONTINUATION.md 测试口径「插件与真装配」：两段截断→stop 续写旅程、
// 四连截断放弃旅程（缺省 max=3）。不引用他包 __test__ 私有文件，装置自建。

import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { toolRegistry } from "@x-harness/tools";
import { createContext, loadPlugins } from "@x-harness/core";
import { agentTurnConclude } from "@x-harness/agent-loop";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import type { Agent, AgentHandle, AgentLoopService } from "@x-harness/agent-loop";
import { createContinuationPlugin, GIVE_UP, OUTPUT_CONTINUATION_INSTRUCTION, OUTPUT_CONTINUATION_SOURCE } from "../index.ts";

const AGENT = { model: "fake-model", provider: "fake" };

function textScript(text: string, finish: "stop" | "max-tokens"): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "usage", usage: { input: 1, output: 2 } };
    yield { type: "finish", finish: { kind: finish } };
  })();
}

function toolScript(spec: { readonly callId: string; readonly name: string; readonly args: string; readonly finish?: "stop" | "max-tokens" }): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "tool-call-delta", index: 0, callId: spec.callId, name: spec.name, argumentsDelta: spec.args };
    yield { type: "usage", usage: { input: 1, output: 2 } };
    yield { type: "finish", finish: { kind: spec.finish ?? "stop" } };
  })();
}

interface Fixture {
  readonly ctx: ReturnType<typeof createContext>;
  readonly loop: AgentLoopService;
  readonly calls: LlmRequest[];
  readonly scripts: AsyncGenerator<LlmChunk>[];
  readonly dispose: () => Promise<void>;
}

async function makeFixture(options?: { readonly maxOutputContinuations?: number }): Promise<Fixture> {
  const ctx = createContext();
  const calls: LlmRequest[] = [];
  const scripts: AsyncGenerator<LlmChunk>[] = [];
  const unload = await loadPlugins(ctx, [
    sessionPlugin,
    toolsPlugin,
    llmPlugin,
    systemPromptPlugin,
    agentLoopPlugin,
    createContinuationPlugin(options),
  ]);
  const off = ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: (request) => {
      calls.push(request);
      return scripts.shift() ?? textScript("(no script)", "stop");
    },
  });
  ctx.effect(off);
  return {
    ctx,
    loop: ctx.use(agentLoopServiceToken),
    calls,
    scripts,
    dispose: async () => {
      await ctx.dispose();
      void unload;
    },
  };
}

async function spawn(fixture: Fixture): Promise<{ agent: Agent; handle: AgentHandle }> {
  const made = await fixture.loop.create({ agent: AGENT });
  expect(made.ok).toBe(true);
  if (!made.ok) throw new Error(made.reason);
  return { agent: made.value.agent, handle: made.value };
}

describe("截断 tool_use 接续（TRUNCATED-TOOL-RESCUE 层 1：全截断 → 收束窗口可达 → 续写接手）", () => {
  it("半截 write + max-tokens → 配对合成结果（不执行）、resume、指令落卷、续写请求末条为指令", async () => {
    const fixture = await makeFixture();
    fixture.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "tool-call-delta", index: 0, callId: "t1", name: "write", argumentsDelta: '{"path":"a.txt","content":"写一半' };
        yield { type: "finish", finish: { kind: "max-tokens" } };
      })(),
      textScript("done", "stop"),
    );
    const made = await fixture.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    const agent = made.value.agent;
    let executed = 0;
    fixture.ctx.use(toolRegistry).register({ name: "write", inputSchema: Type.Object({}), execute: async () => { executed += 1; return { content: "should not run" }; } });
    agent.followup("q");
    await agent.whenIdle();

    const events = agent.session.events();
    const result = events.find((e) => e.type === "tool/result")?.data as Record<string, unknown>;
    expect(result).toMatchObject({ callId: "t1", isError: true, synthetic: true });
    expect(String(result?.["content"])).toContain("truncated: not executed");
    expect(executed).toBe(0); // 半截调用不执行
    // 续写接手：第二次模型调用发生、指令以 agent/message{directive} 落卷、恰一条
    expect(fixture.calls).toHaveLength(2);
    const directives = events.filter((e) => e.type === "agent/message");
    expect(directives).toHaveLength(1);
    // 投影末条为指令（续写请求协议合法：指令在 tool 配对结果之后）
    const last = fixture.calls[1]?.messages.at(-1);
    expect(JSON.stringify(last)).toContain(OUTPUT_CONTINUATION_INSTRUCTION);
    await made.value.dispose();
  });
});

describe("agent-continuation 插件全链（真装配，缺省 max=3）", () => {
  it("两段截断→stop：resume ×2 后续写完成——指令恰进续写请求末条、turn completed、agent/message 恰 2 条", async () => {
    const fixture = await makeFixture();
    for (const script of [textScript("a", "max-tokens"), textScript("b", "max-tokens"), textScript("c", "stop")]) fixture.scripts.push(script);
    const { agent, handle } = await spawn(fixture);
    agent.followup("q");
    await agent.whenIdle();

    expect(fixture.calls).toHaveLength(3);
    const directives = agent.session.events().filter((event) => event.type === "agent/message");
    expect(directives).toHaveLength(2);
    for (const directive of directives) {
      expect(directive.data).toMatchObject({ source: OUTPUT_CONTINUATION_SOURCE, kind: "directive", content: [{ type: "text", text: OUTPUT_CONTINUATION_INSTRUCTION }] });
    }
    // 两个续写请求的末条都是指令（投影携带、保序）；第三请求完成后 completed
    for (const request of fixture.calls.slice(1)) {
      expect(request.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: OUTPUT_CONTINUATION_INSTRUCTION }] });
    }
    expect(agent.session.events().at(-1)?.data).toEqual({ turn: 0, reason: { kind: "completed" } });
    await handle.dispose();
    await fixture.dispose();
  });

  it("四连截断：resume ×3 后第 4 次放弃——error 终态（GIVE_UP 常量）、4 条 partial 全落账", async () => {
    const fixture = await makeFixture();
    for (const script of [textScript("a", "max-tokens"), textScript("b", "max-tokens"), textScript("c", "max-tokens"), textScript("d", "max-tokens")]) {
      fixture.scripts.push(script);
    }
    const { agent, handle } = await spawn(fixture);
    agent.followup("q");
    await agent.whenIdle();

    expect(fixture.calls).toHaveLength(4);
    expect(agent.session.events().filter((event) => event.type === "agent/message")).toHaveLength(3);
    expect(agent.session.events().filter((event) => event.type === "assistant/message")).toHaveLength(4); // 保存先于判定
    expect(agent.session.events().at(-1)?.data).toEqual({ turn: 0, reason: { kind: "error", message: GIVE_UP.message, code: GIVE_UP.code } });
    await handle.dispose();
    await fixture.dispose();
  });

  it("max=0：首次截断即放弃（禁用语义）——无 resume、单请求、error 终态", async () => {
    const fixture = await makeFixture({ maxOutputContinuations: 0 });
    fixture.scripts.push(textScript("a", "max-tokens"));
    const { agent, handle } = await spawn(fixture);
    agent.followup("q");
    await agent.whenIdle();
    expect(fixture.calls).toHaveLength(1);
    expect(agent.session.events().filter((event) => event.type === "agent/message")).toHaveLength(0);
    expect(agent.session.events().at(-1)?.data).toEqual({ turn: 0, reason: { kind: "error", message: GIVE_UP.message, code: GIVE_UP.code } });
    await handle.dispose();
    await fixture.dispose();
  });

  it("next 纪律契约：中间件不调 next → 内核违约 throw → 逃逸 error 收轮（fail-loud）", async () => {
    const fixture = await makeFixture();
    const off = fixture.ctx.on(agentTurnConclude, (async () => ({ kind: "fail", message: "x", code: "y" })) as never);
    fixture.scripts.push(textScript("half", "max-tokens"));
    const { agent, handle } = await spawn(fixture);
    agent.followup("q");
    await agent.whenIdle();
    const reason = (agent.session.events().at(-1) as unknown as { data: { reason: { kind: string; message: string } } }).data.reason;
    expect(reason.kind).toBe("error");
    expect(reason.message).toMatch(/without calling next/);
    off();
    await handle.dispose();
    await fixture.dispose();
  });

  it("默认装配翻转钉死（WER 批 A）：完整工具块 max-tokens → 窗口派发、hasTools 让位 → 粘性 max-tokens（与旧行为等价终态）", async () => {
    const fixture = await makeFixture();
    fixture.ctx.use(toolRegistry).register({ name: "add", inputSchema: Type.Object({}), execute: async () => ({ content: "3" }) });
    const conclude: Array<Record<string, unknown>> = [];
    const off = fixture.ctx.on(agentTurnConclude, (async (payload: unknown, next: (input: unknown) => Promise<unknown>) => {
      const downstream = await next(payload);
      conclude.push(payload as Record<string, unknown>);
      return downstream;
    }) as never);
    fixture.scripts.push(toolScript({ callId: "c1", name: "add", args: "{}", finish: "max-tokens" }));
    const { agent, handle } = await spawn(fixture);
    agent.followup("q");
    await agent.whenIdle();

    expect(fixture.calls).toHaveLength(1); // 无续写请求
    expect(conclude).toHaveLength(1); // 窗口派发达（带工具不再结构不可达）
    expect(conclude[0]).toMatchObject({ stopReason: "max-tokens", hasTools: true, truncatedCount: 0 }); // 事实载荷
    const events = agent.session.events();
    expect(events.filter((e) => e.type === "tool/result")).toHaveLength(1); // 工具照常执行
    expect(events.filter((e) => e.type === "agent/message")).toHaveLength(0); // 插件让位：无指令
    expect(events.at(-1)?.data).toEqual({ turn: 0, reason: { kind: "max-tokens" } }); // 旧粘性终态等价
    off();
    await handle.dispose();
    await fixture.dispose();
  });

  it("无插件世界等价（回归）：同流不装本插件 → 同样粘性 max-tokens 终态、无续写", async () => {
    const ctx = createContext();
    const calls: LlmRequest[] = [];
    const scripts: AsyncGenerator<LlmChunk>[] = [];
    const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, llmPlugin, systemPromptPlugin, agentLoopPlugin]);
    const off = ctx.use(llmRuntime).registerAdapter({ name: "fake", stream: (request) => { calls.push(request); return scripts.shift() ?? textScript("(no script)", "stop"); } });
    ctx.effect(off);
    ctx.use(toolRegistry).register({ name: "add", inputSchema: Type.Object({}), execute: async () => ({ content: "3" }) });
    scripts.push(toolScript({ callId: "c1", name: "add", args: "{}", finish: "max-tokens" }));
    const made = await ctx.use(agentLoopServiceToken).create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.followup("q");
    await made.value.agent.whenIdle();
    expect(calls).toHaveLength(1);
    expect(made.value.agent.session.events().at(-1)?.data).toEqual({ turn: 0, reason: { kind: "max-tokens" } });
    await made.value.dispose();
    await ctx.dispose();
    void unload;
  });

  it("stop 正常完成：插件让位——零 agent/message、现行行为不变", async () => {
    const fixture = await makeFixture();
    fixture.scripts.push(textScript("hello", "stop"));
    const { agent, handle } = await spawn(fixture);
    agent.followup("q");
    await agent.whenIdle();
    expect(fixture.calls).toHaveLength(1);
    expect(agent.session.events().filter((event) => event.type === "agent/message")).toHaveLength(0);
    expect(agent.session.events().at(-1)?.data).toEqual({ turn: 0, reason: { kind: "completed" } });
    await handle.dispose();
    await fixture.dispose();
  });
});
