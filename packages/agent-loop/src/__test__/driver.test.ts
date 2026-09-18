// 驱动状态机全链（docs/AGENT-LOOP-DRIVER §3）：真实装配 session+tools+llm+system-prompt，
// 脚本化假 LLM 适配器 + 假工具；事件序列逐条断言。

import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { SessionEvent, SessionStore } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { Type } from "@sinclair/typebox";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolRegistry } from "@x-harness/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentLoopPlugin, agentLoopServiceToken, agentPreStep, agentRequest, agentRequestError, agentStatus, agentTurnStopping } from "../index.ts";
import type { Agent, AgentHandle, AgentLoopService } from "../index.ts";

/** 脚本化假适配器：每次调用弹出一段脚本 */
function fakeAdapter(): { scripts: Array<AsyncGenerator<LlmChunk> | ((request: LlmRequest) => AsyncGenerator<LlmChunk>)>; calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const scripts: Array<AsyncGenerator<LlmChunk> | ((request: LlmRequest) => AsyncGenerator<LlmChunk>)> = [];
  return {
    calls,
    scripts,
  };
}

function textScript(text: string, finish: "stop" | "max-tokens" = "stop"): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "usage", usage: { input: 1, output: 2 } };
    yield { type: "finish", finish: { kind: finish } };
  })();
}

function toolScript(callId: string, name: string, args: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "tool-call-delta", index: 0, callId, name, argumentsDelta: args };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

function errorScript(message: string, code?: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "finish", finish: { kind: "error", message, code } };
  })();
}

interface World {
  ctx: Context;
  loop: AgentLoopService;
  store: SessionStore;
  tools: ToolRegistry;
  fake: ReturnType<typeof fakeAdapter>;
  cleanup: () => Promise<void>;
}

async function makeWorld(): Promise<World> {
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

const AGENT = { model: "fake-model", provider: "fake" };

let worlds: World[] = [];
beforeEach(() => {
  worlds = [];
});
afterEach(async () => {
  for (const world of worlds) await world.cleanup().catch(() => {});
});

async function spawn(world: World): Promise<{ handle: AgentHandle; agent: Agent }> {
  const made = await world.loop.create({ agent: AGENT });
  expect(made.ok).toBe(true);
  if (!made.ok) throw new Error(made.reason);
  return { handle: made.value, agent: made.value.agent };
}

const types = (agent: Agent): string[] => agent.session.events().map((event: SessionEvent) => event.type);

describe("状态机事件序列（docs/AGENT-LOOP-DRIVER §3）", () => {
  it("fresh turn（无工具）：claim→step 括号→system 锚点→user→header→assistant→completed 收轮", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.fake.scripts.push(textScript("hello"));
    const { agent, handle } = await spawn(world);
    agent.followup("hi");
    await agent.whenIdle();
    expect(types(agent)).toEqual([
      "agent/inbox/spliced", // insert
      "turn/start",
      "agent/inbox/spliced", // claim
      "step/start",
      "system/message",
      "user/message",
      "request/header",
      "request/context",
      "assistant/message",
      "step/end",
      "turn/end",
    ]);
    const turnEnd = agent.session.events().at(-1);
    expect(turnEnd?.data).toEqual({ turn: 0, reason: { kind: "completed" } });
    const assistant = agent.session.events().find((e) => e.type === "assistant/message");
    expect(assistant?.data).toMatchObject({ stopReason: "stop", usage: { input: 1, output: 2 } });
    // 请求体纯折叠不变量
    expect(world.fake.calls[0]?.messages).toEqual(agent.session.deriveMessages().slice(0, -1));
    await handle.dispose();
  });

  it("多步工具 turn：tool_use→tool/call→tool/result→下一步→completed", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.tools.register({
      name: "add",
      inputSchema: Type.Object({ a: Type.Integer() }),
      execute: async () => ({ content: "3" }),
    });
    world.fake.scripts.push(toolScript("c1", "add", '{"a":1}'));
    world.fake.scripts.push(textScript("done"));
    const { agent, handle } = await spawn(world);
    agent.followup("add 1");
    await agent.whenIdle();
    expect(types(agent)).toEqual([
      "agent/inbox/spliced",
      "turn/start",
      "agent/inbox/spliced",
      "step/start",
      "system/message",
      "user/message",
      "request/header",
      "request/context",
      "assistant/message",
      "tool/call",
      "tool/result",
      "step/end",
      "step/start", // 第二步：无新领取 → 无 claim 无 user/message；header 未变 → 不落
      "assistant/message",
      "step/end",
      "turn/end",
    ]);
    expect(agent.session.events().filter((e) => e.type === "tool/result")[0]?.data).toMatchObject({ callId: "c1", content: "3" });
    await handle.dispose();
  });

  it("steer 续航：turn-stopping 窗口后重读收件箱继续", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "text-delta", text: "first" };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    );
    // turn-stopping 监听器：steer 注入（数据驱动续航）；一次性守卫——每次 stopping 都注入会无限续航
    let steered = false;
    const off = world.ctx.on(agentTurnStopping, ({ session, turn }) => {
      void session;
      void turn;
      if (steered) return;
      steered = true;
      agent.steer("mid-turn correction");
    });
    agent.followup("go");
    await agent.whenIdle();
    off();
    const eventTypes = types(agent);
    expect(eventTypes.filter((t) => t === "turn/start")).toHaveLength(1); // 同一 turn 续航
    expect(eventTypes.filter((t) => t === "user/message")).toHaveLength(2); // 原批次 + steer
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
    await handle.dispose();
  });

  it("回归：steer 流中注入（stop 无工具）不搁浅——completed 前重读收件箱续航消化", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "text-delta", text: "first" };
        agent.steer("late question"); // 流中注入：模型已产出但未 finish
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    );
    world.fake.scripts.push(textScript("answered"));
    agent.followup("go");
    await agent.whenIdle();
    const eventTypes = types(agent);
    expect(eventTypes.filter((t) => t === "turn/start")).toHaveLength(1); // 同 turn 续航，不另起 turn
    expect(eventTypes.filter((t) => t === "user/message")).toHaveLength(2); // 原批次 + 流中 steer 均被消化
    expect(world.fake.calls).toHaveLength(2); // 第二次请求消化 steer
    const steered = world.fake.calls[1]?.messages.find((m) => m.role === "user" && JSON.stringify(m.content).includes("late question"));
    expect(steered).toBeDefined(); // 不搁浅：steer 进入后续请求
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
    await handle.dispose();
  });

  it("abort 中途：interrupted 消息（有部分文本）+ aborted cause", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "text-delta", text: "partial" };
        await new Promise(() => {}); // 悬停流
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    );
    const { agent, handle } = await spawn(world);
    agent.followup("hi");
    await vi.waitFor(() => expect(world.fake.calls.length).toBe(1));
    agent.cancel("user");
    await agent.whenIdle();
    const assistant = agent.session.events().find((e) => e.type === "assistant/message");
    expect(assistant?.data).toMatchObject({ interrupted: true });
    expect(agent.session.events().at(-1)?.data).toEqual({ turn: 0, reason: { kind: "aborted", cause: "user" } });
    // cancel 缺省清收件箱
    const clear = agent.session.events().find((e) => e.type === "agent/inbox/spliced" && e.data.op === "clear");
    expect(clear?.data).toMatchObject({ reason: "user" });
    await handle.dispose();
  });

  it("request-error retry：中间件返 retry → 重进 attempt；缺省终态 error", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    let retried = 0;
    const off = world.ctx.on(
      agentRequestError,
      async (payload: unknown, next: (input: unknown) => Promise<unknown>): Promise<{ kind: "retry" } | undefined> => {
        await next(payload); // 内核 I2：必须调 next
        retried += 1;
        return retried <= 1 ? { kind: "retry" } : undefined;
      },
    );
    world.fake.scripts.push(errorScript("E1", "E_TIMEOUT"), errorScript("E2"));
    agent.followup("hi");
    await agent.whenIdle();
    off();
    expect(retried).toBe(2);
    const attempts = agent.session.events().filter((e) => e.type === "assistant/attempt");
    expect(attempts.map((e) => (e.data as { error: string }).error)).toEqual(["E_TIMEOUT:E1", "E2"]);
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "error", message: "E2" } });
    // retry 不重落 system/user/header（§1.4 承诺）：锚点与请求头各恰一条
    const retryTypes = types(agent);
    expect(retryTypes.filter((t) => t === "system/message")).toHaveLength(1);
    expect(retryTypes.filter((t) => t === "user/message")).toHaveLength(1);
    expect(retryTypes.filter((t) => t === "request/header")).toHaveLength(1);
    await handle.dispose();
  });

  it("no-model：无拨号 → error 收轮不花模型调用", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, llmPlugin, systemPromptPlugin, agentLoopPlugin]);
    const fake = fakeAdapter();
    const off = ctx.use(llmRuntime).registerAdapter({
      name: "fake",
      stream: (request) => {
        fake.calls.push(request);
        return textScript("x");
      },
    });
    ctx.effect(off);
    const loop = ctx.use(agentLoopServiceToken);
    const made = await loop.create({});
    expect(made.ok).toBe(true);
    if (made.ok) {
      made.value.agent.followup("hi");
      await made.value.agent.whenIdle();
      expect(made.value.agent.session.events().at(-1)?.data).toMatchObject({
        reason: { kind: "error", message: "no model configured", code: "no-model" },
      });
      expect(fake.calls).toHaveLength(0);
      await made.value.dispose();
    }
    await ctx.dispose();
    void unload;
  });

  it("并发 followup：链式多 turn（每 turn 领一条 next-turn）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.fake.scripts.push(textScript("a"), textScript("b"));
    const { agent, handle } = await spawn(world);
    agent.followup("first");
    agent.followup("second");
    await agent.whenIdle();
    expect(agent.session.events().filter((e) => e.type === "turn/start")).toHaveLength(2);
    expect(agent.session.events().filter((e) => e.type === "turn/end")).toHaveLength(2);
    await handle.dispose();
  });

  it("unknown tool：isError 结果 + 多步继续（模型自纠）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.fake.scripts.push(toolScript("c9", "nope", "{}"), textScript("recovered"));
    const { agent, handle } = await spawn(world);
    agent.followup("x");
    await agent.whenIdle();
    const result = agent.session.events().find((e) => e.type === "tool/result");
    expect(result?.data).toMatchObject({ isError: true, content: "unknown-tool:nope" });
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
    await handle.dispose();
  });

  it("max-tokens 粘性（回归：带 tool_use 的截断）：工具结果落账、不另起 step、终态 max-tokens", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.tools.register({
      name: "add",
      inputSchema: Type.Object({}),
      execute: async () => ({ content: "1" }),
    });
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "tool-call-delta", index: 0, callId: "c1", name: "add", argumentsDelta: "{}" };
        yield { type: "finish", finish: { kind: "max-tokens" } };
      })(),
      textScript("never-consumed"),
    );
    const { agent, handle } = await spawn(world);
    agent.followup("hi");
    await agent.whenIdle();
    // 截断的 tool_use 仍执行且结果落账
    expect(agent.session.events().some((e) => e.type === "tool/result" && (e.data as { callId?: string }).callId === "c1")).toBe(true);
    // 粘性：无后续 step 消化、无第二次模型调用
    expect(world.fake.calls).toHaveLength(1);
    expect(agent.session.events().filter((e) => e.type === "step/start")).toHaveLength(1);
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "max-tokens" } });
    await handle.dispose();
  });

  it("preStep reject：回灌 + blocked；blocked 不链式（无活锁）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const off = world.ctx.on(
      agentPreStep,
      async (payload: unknown, next: (input: unknown) => Promise<unknown>): Promise<{ kind: "reject"; reason: string }> => {
        await next(payload);
        return { kind: "reject", reason: "guard" };
      },
    );
    const { agent, handle } = await spawn(world);
    agent.followup("hi");
    await agent.whenIdle();
    off();
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "blocked" } });
    // 回灌（回归：同 id、保原 target）：claim 的 id 原样重新在场——repair trailing-claim 依赖同 id 判重
    const spliced = agent.session.events().filter((e) => e.type === "agent/inbox/spliced");
    const claim = spliced.find((e) => e.data.op === "claim");
    const reinserts = spliced.filter((e) => e.data.op === "insert" && e !== spliced[0]);
    expect(reinserts).toHaveLength(1);
    expect((reinserts[0] as { data: { target?: string } }).data.target).toBe("next-turn");
    const claimIds = (claim as unknown as { data: { claimed?: string[] } }).data.claimed ?? [];
    const reinsertIds = ((reinserts[0] as { data: { entries?: Array<{ id: string }> } }).data.entries ?? []).map((entry) => entry.id);
    expect(reinsertIds).toEqual(claimIds);
    await handle.dispose();
  });

  it("回归：cancel 后再 followup 复活——sticky 取消以 kick 边界为界，不砖化", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "text-delta", text: "partial" };
        await new Promise(() => {}); // 悬停流
      })(),
    );
    const { agent, handle } = await spawn(world);
    agent.followup("q1");
    await vi.waitFor(() => expect(world.fake.calls.length).toBe(1));
    agent.cancel("user-stop");
    await agent.whenIdle();
    // 取消后再 followup：必须能开新 turn（曾因 wake 入口查 cancelled 永久失效）
    world.fake.scripts.push(textScript("ok2"));
    agent.followup("q2");
    await agent.whenIdle();
    expect(agent.session.events().filter((e) => e.type === "turn/start")).toHaveLength(2);
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
    expect(agent.status).toBe("idle");
    await handle.dispose();
  });

  it("回归：abort 无部分文本 → attempt 落账 + aborted cause 终态（不误标 error）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        await new Promise(() => {}); // 悬停且无产出
        yield { type: "finish", finish: { kind: "stop" } }; // 不可达：悬停流必被 abort 赛跑打断
      })(),
    );
    const { agent, handle } = await spawn(world);
    agent.followup("hi");
    await vi.waitFor(() => expect(world.fake.calls.length).toBe(1));
    agent.cancel("user-stop");
    await agent.whenIdle();
    const attempt = agent.session.events().find((e) => e.type === "assistant/attempt");
    expect(attempt?.data).toMatchObject({ error: "aborted" });
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "aborted", cause: "user-stop" } });
    await handle.dispose();
  });

  it("回归：中间件逃逸 throw → turn 以 error 单次收尾（不双落 turn/end、不谎报 completed）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const off = world.ctx.on(agentPreStep, async (payload: unknown, next: (input: unknown) => Promise<unknown>) => {
      await next(payload); // 内核 I2：先放行再炸
      throw new Error("mw-blew");
    });
    const { agent, handle } = await spawn(world);
    agent.followup("hi");
    await agent.whenIdle();
    off();
    const ends = agent.session.events().filter((e) => e.type === "turn/end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.data).toMatchObject({ reason: { kind: "error", message: "mw-blew" } });
    await handle.dispose();
  });

  it("回归：agentRequest 返垃圾 dial → bad-dial error 收轮，不进流", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const off = world.ctx.on(agentRequest, async (payload: unknown, next: (input: unknown) => Promise<unknown>) => {
      await next(payload);
      return undefined as never; // 违约输出：非同形四字段
    });
    const { agent, handle } = await spawn(world);
    agent.followup("hi");
    await agent.whenIdle();
    off();
    expect(world.fake.calls).toHaveLength(0);
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "error", code: "bad-dial" } });
    await handle.dispose();
  });

  it("回归：concludesTurn 带 contexts → 模型续调普通工具时 conclude 延后消化（不半途强制收轮）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.tools.register({
      name: "t",
      inputSchema: Type.Object({ mode: Type.String() }),
      execute: async (args) => {
        const mode = (args as { mode: string }).mode;
        if (mode !== "fin") return { content: "plain" };
        return { content: "fin", concludesTurn: true, additionalContexts: [{ content: [{ type: "text" as const, text: "ctx" }] }] };
      },
    });
    world.fake.scripts.push(toolScript("c1", "t", '{"mode":"fin"}'), toolScript("c2", "t", '{"mode":"plain"}'), textScript("done"));
    const { agent, handle } = await spawn(world);
    agent.followup("go");
    await agent.whenIdle();
    // 三步：fin（conclude 延后）→ plain（消化 ctx 且模型继续）→ done（completed）
    expect(agent.session.events().filter((e) => e.type === "step/start")).toHaveLength(3);
    expect(agent.session.events().filter((e) => e.type === "tool/result")).toHaveLength(2);
    const assistants = agent.session.events().filter((e) => e.type === "assistant/message");
    expect(assistants.at(-1)?.data).toMatchObject({ stopReason: "stop" });
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
    await handle.dispose();
  });

  it("回归：idle 通告监听器重入 followup → whenIdle 收敛（不提前 resolve 到 running 态）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    let refollowed = false;
    const off = world.ctx.on(agentStatus, ({ status }: { status: "idle" | "running" }) => {
      if (status === "idle" && !refollowed) {
        refollowed = true;
        agent.followup("again");
      }
    });
    world.fake.scripts.push(textScript("a"), textScript("b"));
    agent.followup("first");
    await agent.whenIdle();
    off();
    expect(agent.session.events().filter((e) => e.type === "turn/start")).toHaveLength(2);
    expect(agent.status).toBe("idle"); // whenIdle 返回时必须真的 idle
    await handle.dispose();
  });

  it("回归：step≥1 reject 且领取为空 → blocked 且不落空 entries 的 insert（无回灌噪音）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.tools.register({
      name: "add",
      inputSchema: Type.Object({}),
      execute: async () => ({ content: "1" }),
    });
    const off = world.ctx.on(agentPreStep, async (payload: unknown, next: (input: unknown) => Promise<unknown>) => {
      await next(payload);
      if ((payload as { step: number }).step === 1) return { kind: "reject", reason: "guard" };
      return { kind: "enter" } as never;
    });
    world.fake.scripts.push(toolScript("c1", "add", "{}"));
    const { agent, handle } = await spawn(world);
    agent.followup("hi");
    await agent.whenIdle();
    off();
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "blocked" } });
    const inserts = agent.session.events().filter((e) => e.type === "agent/inbox/spliced" && (e.data as { op?: string }).op === "insert");
    expect(inserts).toHaveLength(1); // 仅 followup 的 insert：空领取 reject 无回灌噪音
    await handle.dispose();
  });

  it("dispose：cancel disposed → whenIdle → 会话封存", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    agent.followup("hi");
    await handle.dispose();
    expect(agent.session.append("turn/start", { turn: 99 })).toMatchObject({ ok: false, reason: "session-disposed" });
  });
});
