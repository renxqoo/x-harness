// llm-retry 全套（docs/LLM-RETRY.md §3，对照 R1–R19 真缺口）：退避表驱动/Retry-After 三态/
// 预算烧尽/审计事件先于等待/取消与 dispose 排空/委托/上下文干净（R12）。

import { createContext, loadPlugins } from "@x-harness/core";
import type { Context, Plugin } from "@x-harness/core";
import { agentLoopPlugin, agentLoopServiceToken, agentRequestError } from "@x-harness/agent-loop";
import type { AgentHandle } from "@x-harness/agent-loop";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin } from "@x-harness/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffDelay, createLlmRetryPlugin, validatePolicy } from "../index.ts";
import type { RetryPolicy } from "../index.ts";

interface World {
  ctx: Context;
  scripts: Array<AsyncGenerator<LlmChunk>>;
  calls: LlmRequest[];
  cleanup: () => Promise<void>;
}

let worlds: World[] = [];
beforeEach(() => {
  worlds = [];
});
afterEach(async () => {
  for (const world of worlds) await world.cleanup().catch(() => {});
});

function errorFinish(message: string, code: string, retryAfterMs?: number): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "finish", finish: { kind: "error", message, code, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } };
  })();
}

function scriptAdapterFactory(scripts: Array<AsyncGenerator<LlmChunk>>, calls: LlmRequest[]): (request: LlmRequest) => AsyncGenerator<LlmChunk> {
  return (request: LlmRequest) => {
    calls.push(request);
    const next = scripts.shift();
    return next ?? textFinish("x");
  };
}

function textFinish(text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

/** 真实装配（假适配器脚本队列）；delay 传 0 让退避立即到点（退避数值由表驱动单测单独覆盖） */
async function makeWorld(policyOver: Partial<RetryPolicy> = {}, extra: Plugin[] = []): Promise<World> {
  const ctx = createContext();
  const scripts: Array<AsyncGenerator<LlmChunk>> = [];
  const calls: LlmRequest[] = [];
  const unload = await loadPlugins(ctx, [
    sessionPlugin,
    toolsPlugin,
    llmPlugin,
    systemPromptPlugin,
    agentLoopPlugin,
    createLlmRetryPlugin({
      providers: { fake: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 10_000, jitterRatio: 0, ...policyOver } },
      random: () => 0.5,
    }),
    ...extra,
  ]);
  const off = ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: (request) => {
      calls.push(request);
      const next = scripts.shift();
      if (next === undefined) return textFinish("(no script)");
      return next;
    },
  });
  ctx.effect(off);
  return { ctx, scripts, calls, cleanup: async () => { await ctx.dispose(); void unload; } };
}

async function spawn(world: World) {
  const made = await world.ctx.use(agentLoopServiceToken).create({ agent: { model: "fake-model", provider: "fake" } });
  expect(made.ok).toBe(true);
  if (!made.ok) throw new Error(made.reason);
  return made.value;
}

describe("退避计算表驱动（docs/LLM-RETRY.md §1——R1/R2/R3）", () => {
  const policy: RetryPolicy = { maxRetries: 5, initialDelayMs: 2_000, maxDelayMs: 10_000, jitterRatio: 0.1 };
  const mid = (): number => 0.5; // 抖动因子 = 1

  it.each([
    ["指数序列", 1, 2_000],
    ["翻倍", 2, 4_000],
    ["封顶", 4, 10_000], // 2000×2³=16000 → 硬封顶
  ])("%s：retry %d → %d ms", (_name, retry, expected) => {
    expect(backoffDelay({ policy, retry, retryAfterMs: undefined, random: mid })).toBe(expected);
  });

  it("抖动上下界：ratio=1 时 factor∈[0,2]，且始终 ≤ maxDelayMs（硬封顶）", () => {
    const wobbly: RetryPolicy = { ...policy, jitterRatio: 1 };
    expect(backoffDelay({ policy: wobbly, retry: 1, retryAfterMs: undefined, random: () => 0 })).toBe(0); // 下界 0 合法（立即重试）
    expect(backoffDelay({ policy: wobbly, retry: 1, retryAfterMs: undefined, random: () => 1 })).toBe(2_000 * 2); // 抖动放大但未超 initial×2
    expect(backoffDelay({ policy: wobbly, retry: 5, retryAfterMs: undefined, random: () => 1 })).toBe(10_000); // 抖动后 min 硬封顶
  });

  it("Retry-After 三态：≤上限原样（0 合法）/超上限放弃(undefined)/缺席走指数", () => {
    expect(backoffDelay({ policy, retry: 1, retryAfterMs: 0, random: mid })).toBe(0);
    expect(backoffDelay({ policy, retry: 1, retryAfterMs: 2_500, random: mid })).toBe(2_500);
    expect(backoffDelay({ policy, retry: 1, retryAfterMs: 10_001, random: mid })).toBeUndefined();
    expect(backoffDelay({ policy, retry: 1, retryAfterMs: undefined, random: mid })).toBe(2_000);
  });

  it("策略校验表：maxRetries 负/initial 0/max 超 setTimeout 域/jitter 越界/空 code → throw", () => {
    const ok: RetryPolicy = { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 };
    expect(() => validatePolicy(ok, "x")).not.toThrow();
    expect(() => validatePolicy({ ...ok, maxRetries: -1 }, "x")).toThrow();
    expect(() => validatePolicy({ ...ok, initialDelayMs: 0 }, "x")).toThrow();
    expect(() => validatePolicy({ ...ok, maxDelayMs: 2_147_483_648 }, "x")).toThrow();
    expect(() => validatePolicy({ ...ok, jitterRatio: 1.5 }, "x")).toThrow();
    expect(() => validatePolicy({ ...ok, retryableCodes: [""] }, "x")).toThrow();
  });
});

describe("端到端重试（真实装配，R4/R6/R7/R12）", () => {
  it("瞬时错误自动重试后成功；llm/retry 审计事件先于等待落账；请求体与首次一致（R12）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const handle = await spawn(world);
    world.scripts.push(errorFinish("http-503:upstream", "http-503"), textFinish("recovered"));
    handle.agent.followup("hi");
    await handle.agent.whenIdle();
    expect(world.calls).toHaveLength(2); // 重试重拨
    expect(JSON.stringify(world.calls[0]?.messages)).toBe(JSON.stringify(world.calls[1]?.messages)); // 失败诊断与部分输出不进重试上下文
    const retryEvent = handle.agent.session.events().find((e) => e.type === "llm/retry");
    expect(retryEvent?.data).toMatchObject({ turn: 0, step: 0, provider: "fake", retry: 1, failure: { code: "http-503" } });
    expect(handle.agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
    await handle.dispose();
  });

  it("非瞬态（http-401）零定时器直达失败；预算烧尽后终态 error", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const handle = await spawn(world);
    world.scripts.push(errorFinish("http-401:bad key", "http-401"));
    handle.agent.followup("hi");
    await handle.agent.whenIdle();
    expect(world.calls).toHaveLength(1);
    expect(handle.agent.session.events().filter((e) => e.type === "llm/retry")).toHaveLength(0);
    expect(handle.agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "error" } });
    await handle.dispose();
  });

  it("预算烧尽：maxRetries=2 → 3 次调用 2 条审计事件后终态 error", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const handle = await spawn(world);
    world.scripts.push(errorFinish("network:x", "network"), errorFinish("network:x", "network"), errorFinish("network:x", "network"));
    handle.agent.followup("hi");
    await handle.agent.whenIdle();
    expect(world.calls).toHaveLength(3); // 首发 + 2 重试
    expect(handle.agent.session.events().filter((e) => e.type === "llm/retry")).toHaveLength(2);
    expect(handle.agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "error" } });
    await handle.dispose();
  });

  it("Retry-After 快车道：retryAfterMs 透传（errorScript → failure.retryAfterMs → 事件 delayMs）", async () => {
    const world = await makeWorld({ initialDelayMs: 5_000 });
    worlds.push(world);
    const handle = await spawn(world);
    world.scripts.push(errorFinish("http-429:slow", "http-429", 0), textFinish("ok")); // 0 = 立即重试
    handle.agent.followup("hi");
    await handle.agent.whenIdle();
    const retryEvent = handle.agent.session.events().find((e) => e.type === "llm/retry");
    expect(retryEvent?.data).toMatchObject({ delayMs: 0 }); // 快车道覆盖指数初值
    expect(handle.agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
    await handle.dispose();
  });
});

describe("取消与处置（R13/R16/R19）", () => {
  it("退避等待中 turn 取消 → 等待即刻胜出、无新调度、aborted 终态", async () => {
    const world = await makeWorld({ initialDelayMs: 60_000, maxDelayMs: 60_000 });
    worlds.push(world);
    const handle = await spawn(world);
    world.scripts.push(errorFinish("http-503:x", "http-503"));
    handle.agent.followup("hi");
    // 审计事件已落（先于等待），退避挂起中
    const hasRetryEvent = (): boolean => handle.agent.session.events().some((e) => e.type === "llm/retry");
    await vi.waitFor(() => expect(hasRetryEvent()).toBe(true));
    handle.agent.cancel("user-stop");
    await handle.agent.whenIdle();
    expect(handle.agent.session.events().filter((e) => e.type === "llm/retry")).toHaveLength(1); // 取消后无新调度
    expect(handle.agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "aborted", cause: "user-stop" } });
    await handle.dispose();
  });

  it("dispose 排空在途退避：等待中的重试被 abort 且不重拨", async () => {
    const ctx = createContext();
    const scripts: Array<AsyncGenerator<LlmChunk>> = [];
    const calls: LlmRequest[] = [];
    const unload = await loadPlugins(ctx, [
      sessionPlugin,
      toolsPlugin,
      llmPlugin,
      systemPromptPlugin,
      agentLoopPlugin,
      createLlmRetryPlugin({ providers: { fake: { maxRetries: 2, initialDelayMs: 60_000, maxDelayMs: 60_000, jitterRatio: 0 } }, random: () => 0.5 }),
    ]);
    const factory = scriptAdapterFactory(scripts, calls);
    const off = ctx.use(llmRuntime).registerAdapter({ name: "fake", stream: factory });
    ctx.effect(off);
    const made = await ctx.use(agentLoopServiceToken).create({ agent: { model: "m", provider: "fake" } });
    expect(made.ok).toBe(true);
    if (made.ok) {
      scripts.push(errorFinish("http-503:x", "http-503"));
      made.value.agent.followup("hi");
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      await made.value.dispose(); // dispose：排空在途等待（60s 退避被 abort）
      expect(calls).toHaveLength(1); // 不重拨
    }
    await ctx.dispose();
    void unload;
  });
});

describe("委托与策略归属（R8/R10）", () => {
  it("无策略 provider / 无路线记录且有 default → default 生效；均无 → 委托", async () => {
    // 单元级：直接 dispatch agentRequestError（不经驱动），观察决策
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      sessionPlugin,
      createLlmRetryPlugin({ providers: {}, default: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1_000, jitterRatio: 0 } }),
    ]);
    const store = ctx.use(sessionStore);
    const made = await store.create({ id: "s1" as SessionId });
    expect(made.ok).toBe(true);
    if (made.ok) {
      // 无路线记录 → default 策略 → network 可重试
      const decision = await ctx.dispatch(agentRequestError, {
        session: made.value.id,
        turn: 0,
        step: 0,
        failure: { message: "network:x", code: "network" },
        signal: new AbortController().signal,
      } as never, async () => undefined as never);
      expect(decision).toEqual({ kind: "retry" });
      // 非 retryable code → 委托（undefined）
      const delegated = await ctx.dispatch(agentRequestError, {
        session: made.value.id,
        turn: 0,
        step: 0,
        failure: { message: "http-401:x", code: "http-401" },
        signal: new AbortController().signal,
      } as never, async () => undefined as never);
      expect(delegated).toBeUndefined();
    }
    await ctx.dispose();
    void unload;
  });

  it("回归：预算键含 session——两个会话同 provider 同 (turn,step) 互不烧预算", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const made: AgentHandle[] = [];
    for (const id of ["a", "b"] as const) {
      const result = await world.ctx.use(agentLoopServiceToken).create({ session: { id: id as SessionId }, agent: { model: "m", provider: "fake" } });
      expect(result.ok).toBe(true);
      if (result.ok) made.push(result.value);
    }
    expect(made.length).toBe(2);
    if (made.length < 2) return;
    // 两会话都在 (turn 0, step 0) 失败一次（maxRetries=2）：各自都应获得重试（互不扣减）
    for (let i = 0; i < made.length; i++) {
      world.scripts.push(errorFinish("http-503:x", "http-503"), textFinish("ok"));
    }
    for (const handle of made) handle.agent.followup("hi");
    for (const handle of made) await handle.agent.whenIdle();
    expect(world.calls).toHaveLength(4); // 每会话 2 次（首发+重试）
    for (const handle of made) {
      expect(handle.agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
      await handle.dispose();
    }
  });

  it("会话已封存（store.get 缺位）→ 委托不重试（审计落不上 fail-closed）", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      sessionPlugin,
      createLlmRetryPlugin({ providers: {}, default: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1_000, jitterRatio: 0 } }),
    ]);
    const store = ctx.use(sessionStore);
    const made = await store.create({ id: "sealed" as SessionId });
    expect(made.ok).toBe(true);
    if (made.ok) {
      store.dispose(made.value.id);
      const decision = await ctx.dispatch(agentRequestError, {
        session: made.value.id,
        turn: 0,
        step: 0,
        failure: { message: "network:x", code: "network" },
        signal: new AbortController().signal,
      } as never, async () => undefined as never);
      expect(decision).toBeUndefined(); // 不重试
    }
    await ctx.dispose();
    void unload;
  });

  it("下游 recovery 异常 → stderr 留痕且本插件策略照常运行（重试）", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      sessionPlugin,
      createLlmRetryPlugin({ providers: {}, default: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1_000, jitterRatio: 0 } }),
    ]);
    const traces: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: Uint8Array | string) => {
      traces.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const brokenDownstream = ctx.on(
        agentRequestError,
        async (payload: unknown, next: (input: unknown) => Promise<unknown>) => {
          await next(payload);
          throw new Error("downstream blew");
        },
        { prepend: false },
      );
      const store = ctx.use(sessionStore);
      const made = await store.create({ id: "d" as SessionId });
      expect(made.ok).toBe(true);
      if (made.ok) {
        const decision = await ctx.dispatch(agentRequestError, {
          session: made.value.id,
          turn: 0,
          step: 0,
          failure: { message: "network:x", code: "network" },
          signal: new AbortController().signal,
        } as never, async () => undefined as never);
        expect(decision).toEqual({ kind: "retry" }); // 下游崩不阻断重试
        expect(traces.some((line) => line.includes("downstream recovery threw"))).toBe(true); // 留痕
      }
      brokenDownstream();
    } finally {
      process.stderr.write = originalWrite;
    }
    await ctx.dispose();
    void unload;
  });

  it("更早注册的 recovery 监听器可否决（先注册者决策）", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      sessionPlugin,
      createLlmRetryPlugin({ providers: {}, default: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1_000, jitterRatio: 0 } }),
    ]);
    // prepend：插到监听队列首（外层）——返回值胜过内层重试决策
    const earlier = ctx.on(
      agentRequestError,
      async (payload: unknown, next: (input: unknown) => Promise<unknown>) => {
        await next(payload);
        return undefined;
      },
      { prepend: true },
    );
    const store = ctx.use(sessionStore);
    const made = await store.create({ id: "s2" as SessionId });
    expect(made.ok).toBe(true);
    if (made.ok) {
      const decision = await ctx.dispatch(agentRequestError, {
        session: made.value.id,
        turn: 0,
        step: 0,
        failure: { message: "network:x", code: "network" },
        signal: new AbortController().signal,
      } as never, async () => undefined as never);
      expect(decision).toBeUndefined(); // 内层 retry 的决策被先注册者否决
    }
    earlier();
    await ctx.dispose();
    void unload;
  });
});
