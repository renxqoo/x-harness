// 收束窗口机制测试（docs/OUTPUT-TOKEN-CONTINUATION.md 契约·测试口径「agent-loop 内核机制」节）：
// 窗口契约（派发时点/载荷纯事实/结构保证/垃圾 fail-loud）、resume 应用（指令载体/出口不变量）、
// fail 应用（error 终态/括号配对）、无决策逐字节回归、暂停吸收与保序、持久载体、
// abort/竞态/自愈重试带指令、续写步 preStep 否决。策略本体（3 次计数等）在 agent-continuation 包测。

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
}

/** 注册假策略中间件（next 纪律：让位 = 透传下游；decide 垃圾由用例自带） */
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

    expect(calls).toHaveLength(2); // 第一次 max-tokens 截断、第二次 stop 收尾（插件让位 → 现状路径）
    expect(calls[0]).toMatchObject({ turn: 0, step: 0, stopReason: "max-tokens", rawReason: "max_tokens" });
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

    expect(world.fake.calls).toHaveLength(2); // 续写请求发生（收件箱全空仍发——empty 不可达）
    const messages = world.fake.calls[1]?.messages ?? [];
    expect(messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: INSTRUCTION }] }); // 末条=指令（保序）
    expect(messages.at(-2)).toMatchObject({ role: "assistant" }); // 倒数第二条=截断 partial

    const turnEnd = agent.session.events().at(-1);
    expect(turnEnd?.data).toEqual({ turn: 0, reason: { kind: "completed" } }); // 出口不变量：粘性不残留
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
        yield { type: "finish", finish: { kind: "max-tokens" } }; // content 空、thinking 在场
      })(),
    );
    world.fake.scripts.push(textScript("正文"));
    const { agent, handle } = await spawn(world);
    agent.followup("q");
    await agent.whenIdle();

    expect(calls[0]).toMatchObject({ stopReason: "max-tokens", hasThinking: true }); // 载荷透传
    expect(agentMessages(agent, "agent/message")).toHaveLength(1); // 续写触发——不再静默收轮
    expect(agent.session.events().at(-1)?.data).toEqual({ turn: 0, reason: { kind: "completed" } });
    expect(world.fake.calls[1]?.messages.at(-1)).toMatchObject({ role: "user" }); // 续写请求末条=指令
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
    expect(agentMessages(agent, "agent/message")).toHaveLength(0);
    expect(agent.session.events().at(-1)?.data).toEqual({ turn: 0, reason: { kind: "max-tokens" } });
    off();
    await handle.dispose();
  });

  it("结构保证：带 tool_use 的 max-tokens settle 执行工具、粘性收轮、窗口不派发", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { calls, off } = registerConclude(world, () => resumeOf());
    world.tools.register({ name: "add", inputSchema: Type.Object({}), execute: async () => ({ content: "3" }) });
    world.fake.scripts.push((async function* (): AsyncGenerator<LlmChunk> {
      yield { type: "tool-call-delta", index: 0, callId: "c1", name: "add", argumentsDelta: "{}" };
      yield { type: "finish", finish: { kind: "max-tokens" } };
    })());
    const { agent, handle } = await spawn(world);
    agent.followup("q");
    await agent.whenIdle();
    expect(calls).toHaveLength(0); // 收束点不可达
    expect(agentMessages(agent, "tool/result")).toHaveLength(1); // 工具照常执行
    expect(agent.session.events().at(-1)?.data).toEqual({ turn: 0, reason: { kind: "max-tokens" } }); // 粘性
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
    expect(partials).toHaveLength(4); // 保存先于判定：第 4 次 partial 也已落账
    for (const partial of partials) expect((partial as { data: { stopReason?: string } }).data).toMatchObject({ stopReason: "max-tokens" });
    expect(agentMessages(agent, "agent/message")).toHaveLength(3); // resume ×3
    expect(agent.session.events().at(-1)?.data).toEqual({ turn: 0, reason: { kind: "error", message: GIVE_UP.message, code: "output-token-limit" } });
    const seq = types(agent);
    expect(seq.filter((t) => t === "step/start")).toHaveLength(seq.filter((t) => t === "step/end").length); // 括号配对（含 fail 步）
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
        agent.steer("late steer"); // 流中入队（续写请求已构建——不含它）
        yield { type: "text-delta", text: " done" };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    );
    world.fake.scripts.push(textScript("after steer"));
    agent.followup("q");
    await agent.whenIdle();

    const continuationMessages = (world.fake.calls[1]?.messages ?? []).map((m) => JSON.stringify(m));
    expect(continuationMessages.some((m) => m.includes("late steer"))).toBe(false); // 暂停吸收
    const steerMessages = (world.fake.calls[2]?.messages ?? []).map((m) => JSON.stringify(m));
    expect(steerMessages.some((m) => m.includes("late steer"))).toBe(true); // stopping 窗口消化（不搁浅）
    expect(world.fake.calls).toHaveLength(3);
    // 三元全序：截断 partial < 指令 < steer（保序结构钉死——防未来重构挪位不红）
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
    expect(directiveAt).toBeGreaterThan(-1); // 持久载体：指令仍在（非陈旧泄漏——位置钉死）
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
        agent.cancel("user"); // 流中取消：aborted 赛跑路径
        await new Promise<never>(() => {}); // 悬停流（abort 信号打断汲取）
      })(),
    );
    agent.followup("q");
    await agent.whenIdle();

    const interrupted = agentMessages(agent, "assistant/message").at(-1) as { data: { interrupted?: true } } | undefined;
    expect(interrupted?.data).toMatchObject({ interrupted: true }); // partial 保序落账
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

    expect(world.fake.calls).toHaveLength(3); // 截断 → 失败 → 自愈重试
    const retried = world.fake.calls[2]?.messages ?? [];
    expect(retried.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: INSTRUCTION }] }); // 重试仍是同一续写
    expect(agentMessages(agent, "agent/message")).toHaveLength(1); // retry 不重复落卷
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
    expect(agentAt).toBeGreaterThan(userAt); // 条目序 = 落账序（保序）
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
    expect(inserts).toHaveLength(1); // 仅 followup 的 insert——续写步 reject 无回灌噪音
    off();
    offPre();
    await handle.dispose();
  });
});


describe("scheduleTools 截断分区（docs/TRUNCATED-TOOL-RESCUE.md 层 1）", () => {
  /** 半截 tool call 脚本：arguments 是真半截 JSON 原文（层 1 前置出口）+ max-tokens 终态 */
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

    // 不 dispatch：write 未执行，回显是截断配对文案
    const events = agent.session.events();
    const toolCall = events.find((e) => e.type === "tool/call");
    expect(toolCall?.data).toMatchObject({ callId: "c1", name: "write", arguments: '{"path":"a.txt","content":"写一半' });
    const toolResult = events.find((e) => e.type === "tool/result");
    expect(toolResult?.data).toMatchObject({ callId: "c1", isError: true, synthetic: true });
    expect(String(toolResult?.data.content)).toContain("arguments truncated by output token limit");
    expect(String(toolResult?.data.content)).toContain("Recovered 12 chars");
    // 抢救窗口在配对之前派发（载荷纯事实：半截原文）
    expect(rescueCalls).toHaveLength(1);
    expect(rescueCalls[0]).toMatchObject({ callId: "c1", name: "write", arguments: '{"path":"a.txt","content":"写一半' });
    // 双通道：tool/call 只在 WAL（非 surface）、tool/result 在投影（surface append）——缺 tool/result
    // 投影则配对失效（模型看不到应答）
    const surfaceTypes = agent.session.surface().map((node) => node.event.type);
    expect(surfaceTypes).toContain("tool/result");
    expect(surfaceTypes).not.toContain("tool/call");
    // 事件序：半截 assistant → tool/call → tool/result → 指令（配对先于续写指令落卷）
    const seq = types(agent);
    const at = (t: string, from: number): number => seq.indexOf(t, from);
    const assistantAt = seq.indexOf("assistant/message");
    expect(at("tool/call", assistantAt)).toBeGreaterThan(assistantAt);
    expect(at("tool/result", assistantAt)).toBeGreaterThan(at("tool/call", assistantAt));
    expect(at("agent/message", assistantAt)).toBeGreaterThan(at("tool/result", assistantAt));
    // 收束窗口可达（截断步派发一次；续写成功 stop 步再派发一次）+ 指令落卷 + 第二次模型调用
    expect(concludeCalls).toHaveLength(2);
    expect(concludeCalls[0]?.stopReason).toBe("max-tokens");
    expect(agentMessages(agent, "agent/message")).toHaveLength(1);
    expect(world.fake.calls).toHaveLength(2);
    off();
    offRescue();
    await handle.dispose();
  });

  it("混合：完整调用照常执行、截断的配对不执行；flow ran → 粘性收轮（窗口不派发）", async () => {
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
    expect(okResult).toMatchObject({ content: "wrote" }); // 完整照常执行
    expect(okResult.isError).toBeUndefined(); // 真实执行结果（非合成）
    expect(okResult.synthetic).toBeUndefined();
    expect(byId.get("cut1")).toMatchObject({ isError: true, synthetic: true }); // 截断配对
    expect(String(byId.get("cut1")?.["content"])).toContain("arguments truncated by output token limit");
    // 完整调用恰执行一次、截断调用零执行
    ran = events.filter((e) => e.type === "tool/call").length;
    expect(ran).toBe(2); // 两条 tool/call 都落账（截断的账面 + 完整的账面）
    // 粘性收轮：无第二次模型调用、收束窗口不派发
    expect(world.fake.calls).toHaveLength(1);
    expect(concludeCalls).toHaveLength(0);
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
    expect(result?.["isError"]).toBeUndefined(); // 照常执行非截断配对
    expect(result?.["synthetic"]).toBeUndefined();
    expect(world.fake.calls).toHaveLength(1); // 粘性：无续写
    expect(concludeCalls).toHaveLength(0);
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
      expect(result.content, `garbage=${JSON.stringify(garbage)}`).toBe(TRUNCATED_TOOL_MESSAGE); // 纯 base 文案
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
        made.agent.cancel("test"); // 流中取消：finish 未到，settle 前置 signal 已断
        yield { type: "finish", finish: { kind: "max-tokens" } };
      })(),
    );
    const { agent, handle } = made;
    agent.followup("q");
    await agent.whenIdle();
    expect(dispatched).toBe(0); // 未派发（aborted 全序格盖过抢救增益）
    const result = agent.session.events().find((e) => e.type === "tool/result")?.data as { content?: string } | undefined;
    expect(result?.content).toBeUndefined(); // abort 路径 interrupted 分支收场（配对由 repair 合成）
    off();
    offRescue();
    await handle.dispose();
  });
});
