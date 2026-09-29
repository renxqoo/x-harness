import { Type } from "@sinclair/typebox";
import { describe, expect, it, beforeEach } from "vitest";
import type { LlmChunk } from "@x-harness/llm";
import { agentPreStep, agentRequestError, agentTruncatedTool, agentTurnConclude, TRUNCATED_TOOL_MESSAGE } from "../index.ts";
import type { TurnConcludeDecision } from "../index.ts";
import type { Agent } from "../index.ts";
import { errorScript, makeWorld, resetWorlds, spawn, textScript, toolScript, types, worlds } from "./world.ts";
import type { World } from "./world.ts";

beforeEach(() => {
  resetWorlds();
});

const INSTRUCTION = "Output token limit hit. Resume directly — no apology, no recap.";

interface ConcludePayload {
  readonly turn: number;
  readonly step: number;
  readonly stopReason: "stop" | "max-tokens";
  readonly content: readonly unknown[];
  readonly rawReason?: string;
  readonly hasTools?: boolean;
  readonly truncatedCount?: number;
}

function registerConclude(world: World, decide: (payload: ConcludePayload) => unknown): { calls: ConcludePayload[]; off: () => void } {
  const calls: ConcludePayload[] = [];
  const off = world.ctx.on(agentTurnConclude, async (payload: unknown, next: (input: unknown) => Promise<unknown>) => {
    const downstream = await next(payload);
    calls.push(payload as ConcludePayload);
    if (downstream !== undefined) return downstream;
    return decide(payload as ConcludePayload);
  });
  return { calls, off };
}

const resumeOf = (): Extract<TurnConcludeDecision, { kind: "resume" }> => ({ kind: "resume", source: "output-continuation", instruction: INSTRUCTION });
const GIVE_UP: Extract<TurnConcludeDecision, { kind: "fail" }> = { kind: "fail", message: "The model's response exceeded the output token maximum.", code: "output-token-limit" };

function agentMessages(agent: Agent, type: string): unknown[] {
  return agent.session.events().filter((event) => event.type === type);
}

describe("收束窗口机制（docs/OUTPUT-TOKEN-CONTINUATION.md 契约）", () => {
  it("截断→续写成功：窗口派发恰两次（载荷纯事实）、指令恰进请求末条（投影携带）、agent/message 恰一条、turn completed（出口不变量）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { calls, off } = registerConclude(world, (p) => (p.stopReason === "max-tokens" ? resumeOf() : undefined));
    world.fake.scripts.push((async function* (): AsyncGenerator<LlmChunk> {
      yield { type: "text-delta", text: "half" };
      yield { type: "usage", usage: { input: 1, output: 2 } };
      yield { type: "finish", finish: { kind: "max-tokens", rawReason: "max_tokens" } };
    })());
    world.fake.scripts.push(textScript(" done"));
    const { agent, handle } = await spawn(world);
    agent.followup("q");
    await agent.whenIdle();

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ turn: 0, step: 0, stopReason: "max-tokens", rawReason: "max_tokens", hasTools: false, truncatedCount: 0 });
    expect(calls[0]?.content).toEqual([{ type: "text", text: "half" }]);
    expect(calls[1]).toMatchObject({ stopReason: "stop" });

    const directives = agentMessages(agent, "agent/message");
    expect(directives).toHaveLength(1);
    expect((directives[0] as { data: unknown }).data).toMatchObject({
      turn: 0,
      step: 0,
      source: "output-continuation",
      kind: "directive",
      content: [{ type: "text", text: INSTRUCTION }],
    });

    expect(world.fake.calls).toHaveLength(2);
    const messages = world.fake.calls[1]?.messages ?? [];
    expect(messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: INSTRUCTION }] });
    expect(messages.at(-2)).toMatchObject({ role: "assistant" });

    const turnEnd = agent.session.events().at(-1);
    expect(turnEnd?.data).toEqual({ turn: 0, reason: { kind: "completed" } });
    off();
    await handle.dispose();
  });

  it("回归（用户实报思考型截断）：thinking-only max-tokens → 续写触发（hasThinking 载荷透传）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { calls, off } = registerConclude(world, (p) => (p.stopReason === "max-tokens" ? resumeOf() : undefined));
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "thinking-delta", text: "长思考……预算全花在这里" };
        yield { type: "usage", usage: { input: 141174, output: 8192 } };
        yield { type: "finish", finish: { kind: "max-tokens" } };
      })(),
    );
    world.fake.scripts.push(textScript("正文"));
    const { agent, handle } = await spawn(world);
    agent.followup("q");
    await agent.whenIdle();

    expect(calls[0]).toMatchObject({ stopReason: "max-tokens", hasThinking: true });
    expect(agentMessages(agent, "agent/message")).toHaveLength(1);
    expect(agent.session.events().at(-1)?.data).toEqual({ turn: 0, reason: { kind: "completed" } });
    expect(world.fake.calls[1]?.messages.at(-1)).toMatchObject({ role: "user" });
    off();
    await handle.dispose();
  });

  it("无决策回归：max-tokens 无工具 → 粘性收轮、无 agent/message（现行行为逐字节）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { calls, off } = registerConclude(world, () => undefined);
    world.fake.scripts.push(textScript("half", "max-tokens"));
    const { agent, handle } = await spawn(world);
    agent.followup("q");
    await agent.whenIdle();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ hasTools: false, truncatedCount: 0 });
    expect(agentMessages(agent, "agent/message")).toHaveLength(0);
    expect(agent.session.events().at(-1)?.data).toEqual({ turn: 0, reason: { kind: "max-tokens" } });
    off();
    await handle.dispose();
  });

  it("带工具派发（WER 批 A）：max-tokens + tool_use → 窗口可达（hasTools/truncatedCount 事实）、tool/result 先于派发、让位后粘性收轮", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { calls, off } = registerConclude(world, (p) => (p.stopReason === "max-tokens" && p.hasTools !== true ? resumeOf() : undefined));
    world.tools.register({ name: "add", inputSchema: Type.Object({}), execute: async () => ({ content: "3" }) });
    world.fake.scripts.push((async function* (): AsyncGenerator<LlmChunk> {
      yield { type: "tool-call-delta", index: 0, callId: "c1", name: "add", argumentsDelta: "{}" };
      yield { type: "finish", finish: { kind: "max-tokens" } };
    })());
    const { agent, handle } = await spawn(world);
    agent.followup("q");
    await agent.whenIdle();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ turn: 0, step: 0, stopReason: "max-tokens", hasTools: true, truncatedCount: 0 });
    expect(agentMessages(agent, "tool/result")).toHaveLength(1);
    const seq = types(agent);
    expect(seq.indexOf("tool/result")).toBeLessThan(seq.indexOf("step/end"));
    expect(agentMessages(agent, "agent/message")).toHaveLength(0);
    expect(world.fake.calls).toHaveLength(1);
    expect(agent.session.events().at(-1)?.data).toEqual({ turn: 0, reason: { kind: "max-tokens" } });
    off();
    await handle.dispose();
  });

  it("fail 应用：三连 resume 后第 4 次截断 → error 终态（插件 message/code）、4 条 partial 全落账、括号配对", async () => {
    const world = await makeWorld();
    worlds.push(world);
    let resumes = 0;
    const { calls, off } = registerConclude(world, (p) => {
      if (p.stopReason !== "max-tokens") return undefined;
      resumes += 1;
      return resumes <= 3 ? resumeOf() : GIVE_UP;
    });
    for (let i = 0; i < 4; i++) world.fake.scripts.push(textScript(`seg${String(i)}`, "max-tokens"));
    const { agent, handle } = await spawn(world);
    agent.followup("q");
    await agent.whenIdle();

    expect(calls).toHaveLength(4);
    expect(world.fake.calls).toHaveLength(4);
    const partials = agentMessages(agent, "assistant/message");
    expect(partials).toHaveLength(4);
    for (const partial of partials) expect((partial as { data: { stopReason?: string } }).data).toMatchObject({ stopReason: "max-tokens" });
    expect(agentMessages(agent, "agent/message")).toHaveLength(3);
    expect(agent.session.events().at(-1)?.data).toEqual({ turn: 0, reason: { kind: "error", message: GIVE_UP.message, code: "output-token-limit" } });
    const seq = types(agent);
    expect(seq.filter((t) => t === "step/start")).toHaveLength(seq.filter((t) => t === "step/end").length);
    off();
    await handle.dispose();
  });

  it("暂停吸收与保序：截断后 steer 入队 → 续写请求不含该条目；续写完成后 stopping 窗口消化", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { off } = registerConclude(world, (p) => (p.stopReason === "max-tokens" ? resumeOf() : undefined));
    const { agent, handle } = await spawn(world);
    world.fake.scripts.push(textScript("half", "max-tokens"));
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        agent.steer("late steer");
        yield { type: "text-delta", text: " done" };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    );
    world.fake.scripts.push(textScript("after steer"));
    agent.followup("q");
    await agent.whenIdle();

    const continuationMessages = (world.fake.calls[1]?.messages ?? []).map((m) => JSON.stringify(m));
    expect(continuationMessages.some((m) => m.includes("late steer"))).toBe(false);
    const steerMessages = (world.fake.calls[2]?.messages ?? []).map((m) => JSON.stringify(m));
    expect(steerMessages.some((m) => m.includes("late steer"))).toBe(true);
    expect(world.fake.calls).toHaveLength(3);
    const third = world.fake.calls[2]?.messages ?? [];
    const at = (needle: string): number => third.findIndex((m) => JSON.stringify(m).includes(needle));
    expect(at("half")).toBeLessThan(at(INSTRUCTION));
    expect(at(INSTRUCTION)).toBeLessThan(at("late steer"));
    off();
    await handle.dispose();
  });

  it("持久载体：续写返回 stop+tool_use → 工具步后的请求仍含指令（位置在截断 partial 之后）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { off } = registerConclude(world, (p) => (p.stopReason === "max-tokens" ? resumeOf() : undefined));
    world.tools.register({ name: "add", inputSchema: Type.Object({}), execute: async () => ({ content: "3" }) });
    world.fake.scripts.push(textScript("half", "max-tokens"));
    world.fake.scripts.push(toolScript("c1", "add", "{}"));
    world.fake.scripts.push(textScript("final"));
    const { agent, handle } = await spawn(world);
    agent.followup("q");
    await agent.whenIdle();

    expect(world.fake.calls).toHaveLength(3);
    const third = world.fake.calls[2]?.messages ?? [];
    const directiveAt = third.findIndex((m) => m.role === "user" && JSON.stringify(m.content).includes(INSTRUCTION));
    const partialAt = third.findIndex((m) => m.role === "assistant" && JSON.stringify(m.content).includes("half"));
    expect(directiveAt).toBeGreaterThan(-1);
    expect(directiveAt).toBeGreaterThan(partialAt);
    off();
    await handle.dispose();
  });

  it("垃圾形状 fail-loud：resume 缺 instruction → error 收轮（isDialShape 同款惯例）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { off } = registerConclude(world, () => ({ kind: "resume", source: "x" }) as never);
    world.fake.scripts.push(textScript("half", "max-tokens"));
    const { agent, handle } = await spawn(world);
    agent.followup("q");
    await agent.whenIdle();
    const reason = (agent.session.events().at(-1) as unknown as { data: { reason: { kind: string; message: string } } }).data.reason;
    expect(reason.kind).toBe("error");
    expect(reason.message).toMatch(/agent\/turn-conclude output shape invalid/);
    off();
    await handle.dispose();
  });

  it("abort 于续写流：interrupted partial 落账 + aborted 收轮，无第三次请求", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { off } = registerConclude(world, (p) => (p.stopReason === "max-tokens" ? resumeOf() : undefined));
    const { agent, handle } = await spawn(world);
    world.fake.scripts.push(textScript("half", "max-tokens"));
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "text-delta", text: " more" };
        agent.cancel("user");
        await new Promise<never>(() => {});
      })(),
    );
    agent.followup("q");
    await agent.whenIdle();

    const interrupted = agentMessages(agent, "assistant/message").at(-1) as { data: { interrupted?: true } } | undefined;
    expect(interrupted?.data).toMatchObject({ interrupted: true });
    expect(agent.session.events().at(-1)?.data).toEqual({ turn: 0, reason: { kind: "aborted", cause: "user" } });
    expect(world.fake.calls).toHaveLength(2);
    off();
    await handle.dispose();
  });

  it("自愈重试带指令：attempt 失败（http-413）→ retry → 重试请求仍含指令（投影携带，不重复落卷）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { off } = registerConclude(world, (p) => (p.stopReason === "max-tokens" ? resumeOf() : undefined));
    const offRetry = world.ctx.on(agentRequestError, async (payload: unknown, next: (input: unknown) => Promise<unknown>) => {
      const downstream = await next(payload);
      return downstream ?? { kind: "retry" };
    });
    world.fake.scripts.push(textScript("half", "max-tokens"));
    world.fake.scripts.push(errorScript("request too large", "http-413"));
    world.fake.scripts.push(textScript(" done"));
    const { agent, handle } = await spawn(world);
    agent.followup("q");
    await agent.whenIdle();

    expect(world.fake.calls).toHaveLength(3);
    const retried = world.fake.calls[2]?.messages ?? [];
    expect(retried.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: INSTRUCTION }] });
    expect(agentMessages(agent, "agent/message")).toHaveLength(1);
    off();
    offRetry();
    await handle.dispose();
  });

  it("批次材料化保序：steer→user/message、notify→agent/message 按入队序落账（docs/AGENT-MESSAGE.md §4 场景 C）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    world.fake.scripts.push(textScript("ack"));
    agent.steer("user steer first");
    agent.notify("delegation-report", "content", "report second");
    await agent.whenIdle();
    const surface = agent.session.surface().map((node) => node.event);
    const userAt = surface.findIndex((e) => e.type === "user/message" && JSON.stringify(e.data.content).includes("user steer first"));
    const agentAt = surface.findIndex((e) => e.type === "agent/message" && JSON.stringify(e.data.content).includes("report second"));
    expect(userAt).toBeGreaterThan(-1);
    expect(agentAt).toBeGreaterThan(userAt);
    expect(agent.session.events().filter((e) => e.type === "user/message").length).toBe(1);
    expect(agent.session.events().filter((e) => e.type === "agent/message").length).toBe(1);
    await handle.dispose();
  });

  it("续写步 preStep 否决 → blocked 收轮（无回灌 insert 噪音）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { off } = registerConclude(world, (p) => (p.stopReason === "max-tokens" ? resumeOf() : undefined));
    const offPre = world.ctx.on(agentPreStep, async (payload: unknown, next: (input: unknown) => Promise<unknown>) => {
      const downstream = await next(payload);
      if ((payload as { step: number }).step >= 1 && (downstream as { kind?: string } | undefined)?.kind === "enter") {
        return { kind: "reject", reason: "gate" };
      }
      return downstream;
    });
    world.fake.scripts.push(textScript("half", "max-tokens"));
    const { agent, handle } = await spawn(world);
    agent.followup("q");
    await agent.whenIdle();

    expect(agent.session.events().at(-1)?.data).toEqual({ turn: 0, reason: { kind: "blocked", reason: "gate" } });
    const inserts = agent.session.events().filter((e) => e.type === "agent/inbox/spliced" && (e.data as { op?: string }).op === "insert");
    expect(inserts).toHaveLength(1);
    off();
    offPre();
    await handle.dispose();
  });
});


describe("scheduleTools 截断分区（docs/TRUNCATED-TOOL-RESCUE.md 层 1）", () => {
  function truncatedToolScript(callId: string, name: string, args: string): AsyncGenerator<LlmChunk> {
    return (async function* (): AsyncGenerator<LlmChunk> {
      yield { type: "tool-call-delta", index: 0, callId, name, argumentsDelta: args };
      yield { type: "finish", finish: { kind: "max-tokens" } };
    })();
  }

  it("全截断 → {kind:none}：配对落账（tool/call 非 surface、tool/result surface+isError+synthetic+文案含 note）、不 dispatch、收束窗口派发、续写指令落卷", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.tools.register({ name: "write", inputSchema: Type.Object({}), execute: async () => ({ content: "should not run" }) });
    const { calls: concludeCalls, off } = registerConclude(world, (p) => (p.stopReason === "max-tokens" ? resumeOf() : undefined));
    const rescueCalls: Array<Record<string, unknown>> = [];
    const offRescue = world.ctx.on(agentTruncatedTool, async (payload: unknown, next: (input: unknown) => Promise<unknown>) => {
      const downstream = await next(payload);
      rescueCalls.push(payload as Record<string, unknown>);
      return downstream === undefined ? { note: "Recovered 12 chars of the truncated write." } : downstream;
    });
    world.fake.scripts.push(truncatedToolScript("c1", "write", '{"path":"a.txt","content":"写一半'));
    world.fake.scripts.push(textScript("done"));
    const { agent, handle } = await spawn(world);
    agent.followup("q");
    await agent.whenIdle();

    const events = agent.session.events();
    const toolCall = events.find((e) => e.type === "tool/call");
    expect(toolCall?.data).toMatchObject({ callId: "c1", name: "write", arguments: '{"path":"a.txt","content":"写一半' });
    const toolResult = events.find((e) => e.type === "tool/result");
    expect(toolResult?.data).toMatchObject({ callId: "c1", isError: true, synthetic: true });
    expect(String(toolResult?.data.content)).toContain("truncated: not executed");
    expect(String(toolResult?.data.content)).toContain("Recovered 12 chars");
    expect(rescueCalls).toHaveLength(1);
    expect(rescueCalls[0]).toMatchObject({ callId: "c1", name: "write", arguments: '{"path":"a.txt","content":"写一半' });
    const surfaceTypes = agent.session.surface().map((node) => node.event.type);
    expect(surfaceTypes).toContain("tool/result");
    expect(surfaceTypes).not.toContain("tool/call");
    const seq = types(agent);
    const at = (t: string, from: number): number => seq.indexOf(t, from);
    const assistantAt = seq.indexOf("assistant/message");
    expect(at("tool/call", assistantAt)).toBeGreaterThan(assistantAt);
    expect(at("tool/result", assistantAt)).toBeGreaterThan(at("tool/call", assistantAt));
    expect(at("agent/message", assistantAt)).toBeGreaterThan(at("tool/result", assistantAt));
    expect(concludeCalls).toHaveLength(2);
    expect(concludeCalls[0]?.stopReason).toBe("max-tokens");
    expect(agentMessages(agent, "agent/message")).toHaveLength(1);
    expect(world.fake.calls).toHaveLength(2);
    off();
    offRescue();
    await handle.dispose();
  });

  it("混合：完整调用照常执行、截断的配对不执行；ran 流派发后让位 → 粘性收轮（truncatedCount 事实）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    let ran = 0;
    world.tools.register({ name: "write", inputSchema: Type.Object({}), execute: async () => ({ content: "wrote" }) });
    const { calls: concludeCalls, off } = registerConclude(world, () => undefined);
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "tool-call-delta", index: 0, callId: "ok1", name: "write", argumentsDelta: '{"path":"b.txt","content":"全文"}' };
        yield { type: "tool-call-delta", index: 1, callId: "cut1", name: "write", argumentsDelta: '{"path":"a.txt","content":"写一半' };
        yield { type: "finish", finish: { kind: "max-tokens" } };
      })(),
    );
    const { agent, handle } = await spawn(world);
    agent.followup("q");
    await agent.whenIdle();

    const events = agent.session.events();
    const results = events.filter((e) => e.type === "tool/result");
    expect(results).toHaveLength(2);
    const byId = new Map(results.map((e) => [(e.data as { callId: string }).callId, e.data as Record<string, unknown>]));
    const okResult = byId.get("ok1") as { content: string; isError?: true; synthetic?: true };
    expect(okResult).toMatchObject({ content: "wrote" });
    expect(okResult.isError).toBeUndefined();
    expect(okResult.synthetic).toBeUndefined();
    expect(byId.get("cut1")).toMatchObject({ isError: true, synthetic: true });
    expect(String(byId.get("cut1")?.["content"])).toContain("truncated: not executed");
    ran = events.filter((e) => e.type === "tool/call").length;
    expect(ran).toBe(2);
    expect(world.fake.calls).toHaveLength(1);
    expect(concludeCalls).toHaveLength(1);
    expect(concludeCalls[0]).toMatchObject({ stopReason: "max-tokens", hasTools: true, truncatedCount: 1 });
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "max-tokens" } });
    off();
    await handle.dispose();
  });

  it("全完整 max-tokens（回归）：不分区、照常执行、粘性收轮不变", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.tools.register({ name: "write", inputSchema: Type.Object({}), execute: async () => ({ content: "wrote" }) });
    const { calls: concludeCalls, off } = registerConclude(world, () => undefined);
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "tool-call-delta", index: 0, callId: "c1", name: "write", argumentsDelta: '{"path":"a.txt","content":"全文"}' };
        yield { type: "finish", finish: { kind: "max-tokens" } };
      })(),
    );
    const { agent, handle } = await spawn(world);
    agent.followup("q");
    await agent.whenIdle();

    const result = agent.session.events().find((e) => e.type === "tool/result")?.data as Record<string, unknown>;
    expect(result).toMatchObject({ callId: "c1", content: "wrote" });
    expect(result?.["isError"]).toBeUndefined();
    expect(result?.["synthetic"]).toBeUndefined();
    expect(world.fake.calls).toHaveLength(1);
    expect(concludeCalls).toHaveLength(1);
    expect(concludeCalls[0]).toMatchObject({ hasTools: true, truncatedCount: 0 });
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "max-tokens" } });
    off();
    await handle.dispose();
  });

  it("形状门（裁决⑥）：note 非空串采用；垃圾应答（非 object/空串/无 note）忽略走 base 文案", async () => {
    for (const garbage of [undefined, null, "x", 5, {}, { note: "" }, { note: 7 }]) {
      const world = await makeWorld();
      worlds.push(world);
      world.tools.register({ name: "write", inputSchema: Type.Object({}), execute: async () => ({ content: "should not run" }) });
      const { off } = registerConclude(world, () => undefined);
      const offRescue = world.ctx.on(agentTruncatedTool, async (payload: unknown, next: (input: unknown) => Promise<unknown>) => {
        await next(payload);
        return garbage as never;
      });
      world.fake.scripts.push(
        (async function* (): AsyncGenerator<LlmChunk> {
          yield { type: "tool-call-delta", index: 0, callId: "c1", name: "write", argumentsDelta: '{"path":"a.txt","content":"写一半' };
          yield { type: "finish", finish: { kind: "max-tokens" } };
        })(),
      );
      const { agent, handle } = await spawn(world);
      agent.followup("q");
      await agent.whenIdle();
      const result = agent.session.events().find((e) => e.type === "tool/result")?.data as { content: string };
      expect(result.content, `garbage=${JSON.stringify(garbage)}`).toBe(TRUNCATED_TOOL_MESSAGE);
      off();
      offRescue();
      await handle.dispose();
    }
  });

  it("abort 竞态：signal 已断 → 抢救窗口不派发（note 丢弃）、配对照常落账", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.tools.register({ name: "write", inputSchema: Type.Object({}), execute: async () => ({ content: "should not run" }) });
    const { off } = registerConclude(world, () => undefined);
    let dispatched = 0;
    const offRescue = world.ctx.on(agentTruncatedTool, async (payload: unknown, next: (input: unknown) => Promise<unknown>) => {
      dispatched += 1;
      return next(payload);
    });
    const made = await spawn(world);
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "tool-call-delta", index: 0, callId: "c1", name: "write", argumentsDelta: '{"path":"a.txt","content":"写一半' };
        made.agent.cancel("test");
        yield { type: "finish", finish: { kind: "max-tokens" } };
      })(),
    );
    const { agent, handle } = made;
    agent.followup("q");
    await agent.whenIdle();
    expect(dispatched).toBe(0);
    const result = agent.session.events().find((e) => e.type === "tool/result")?.data as { content?: string } | undefined;
    expect(result?.content).toBeUndefined();
    off();
    offRescue();
    await handle.dispose();
  });
});
