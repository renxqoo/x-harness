// 流空闲看门狗全链（docs/AGENT-LOOP-DRIVER.md §1.4）：真实装配 + 脚本化假适配器。
// 症状回归：LLM 流静默挂死（无数据无错误无超时）曾使 turn 永久卡死——看门狗把挂死收敛为
// 携 code:network 的 attempt → 既有 llm-retry 重拨 → 有界完成；取消语义不受污染。

import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin } from "@x-harness/tools";
import { afterEach, describe, expect, it } from "vitest";
import { agentLoopPlugin, agentLoopServiceToken, agentRequestError } from "../index.ts";
import type { AgentLoopService } from "../index.ts";

function textScript(text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

/** 挂死剧本：吐一帧正文后永久沉默（三起事故同形态） */
function hangScript(text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    await new Promise<never>(() => {});
  })();
}

/** 挂死剧本（signal 感知）：适配器真实形态——监听 request.signal，abort 到达即落定并记录 */
function hangOnSignal(text: string, record: { aborted: boolean }): (request: LlmRequest) => AsyncGenerator<LlmChunk> {
  return (request) =>
    (async function* (): AsyncGenerator<LlmChunk> {
      yield { type: "text-delta", text };
      await new Promise<never>((_, reject) => {
        request.signal.addEventListener("abort", () => {
          record.aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    })();
}


interface World {
  ctx: Context;
  loop: AgentLoopService;
  fake: { scripts: Array<AsyncGenerator<LlmChunk> | ((request: LlmRequest) => AsyncGenerator<LlmChunk>)>; calls: LlmRequest[] };
  cleanup: () => Promise<void>;
}

async function makeWorld(): Promise<World> {
  const ctx = createContext();
  const fake = {
    scripts: [] as Array<AsyncGenerator<LlmChunk> | ((request: LlmRequest) => AsyncGenerator<LlmChunk>)>,
    calls: [] as LlmRequest[],
  };
  const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, llmPlugin, systemPromptPlugin, agentLoopPlugin]);
  const off = ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: (request) => {
      fake.calls.push(request);
      const next = fake.scripts.shift() ?? textScript("(no script)");
      return typeof next === "function" ? next(request) : next;
    },
  });
  ctx.effect(off);
  // 最小重试中间件（llm-retry 的同款挂点）：下游未裁决即重拨——看门狗超时的重试链路端到端背书
  ctx.on(agentRequestError, async (payload, next) => (await next(payload)) ?? ({ kind: "retry" } as const));
  return {
    ctx,
    loop: ctx.use(agentLoopServiceToken),
    fake,
    cleanup: async () => {
      await ctx.dispose();
      void unload;
    },
  };
}

const AGENT = { model: "fake-model", provider: "fake", streamIdleTimeoutMs: 40 } as const;

let worlds: World[] = [];
afterEach(async () => {
  for (const world of worlds) await world.cleanup().catch(() => {});
  worlds = [];
});

describe("流空闲看门狗（docs/AGENT-LOOP-DRIVER.md §1.4）", () => {
  it("挂死流超时 → attempt{code:network} 落账 → 重拨成功后有界完成（症状：kvhh03 turn7 式永久卡死）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.fake.scripts.push(hangScript("partial"), textScript("recovered"));
    const made = await world.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    made.value.agent.followup("hi");
    await made.value.agent.whenIdle();
    const events = made.value.agent.session.events();
    const attempts = events.filter((e) => e.type === "assistant/attempt");
    expect(attempts).toHaveLength(1); // 恰一次失败尝试（无重试件装配——单次超时后终态完成需第二次成功）
    const attemptEvent = attempts[0] as { data: { error?: string } } | undefined;
    expect(attemptEvent).toBeDefined();
    if (attemptEvent !== undefined) {
      expect(String(attemptEvent.data.error)).toContain("network");
    }
    expect(world.fake.calls).toHaveLength(2); // 真实重拨（新请求）
    const final = events.find((e) => e.type === "assistant/message");
    const blocks = ((final ?? { data: undefined }).data as unknown as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
    expect(blocks[0]?.text).toBe("recovered"); // 挂死尝试的部分文本不进正文
    expect(events.at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
  });

  it("正常快速流不受看门狗影响（无 attempt 落账）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.fake.scripts.push(textScript("fine"));
    const made = await world.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    made.value.agent.followup("hi");
    await made.value.agent.whenIdle();
    const events = made.value.agent.session.events();
    expect(events.some((e) => e.type === "assistant/attempt")).toBe(false);
    expect(events.at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
  });

  it("看门狗不污染取消语义：挂死期间 cancel → aborted 收尾（非 network 重试）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.fake.scripts.push(hangScript("partial"));
    const made = await world.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    made.value.agent.followup("hi");
    await new Promise((resolve) => {
      setTimeout(resolve, 10); // 进入挂死窗口
    });
    made.value.agent.cancel("user");
    await made.value.agent.whenIdle();
    const events = made.value.agent.session.events();
    expect(events.at(-1)?.data).toMatchObject({ reason: { kind: "aborted" } }); // 取消语义独占——不被超时改写
    expect(world.fake.calls).toHaveLength(1); // 取消后不重拨
  });

  it("止损可观察：超时后 attempt 级 signal 确实 abort（掐断底层 fetch——突变删除 abort 曾不红）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const record = { aborted: false };
    world.fake.scripts.push(hangOnSignal("partial", record), textScript("recovered"));
    const made = await world.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    made.value.agent.followup("hi");
    await made.value.agent.whenIdle();
    expect(record.aborted).toBe(true); // 看门狗超时 → attempt signal abort → 挂死流被打断落定
    expect(world.fake.calls).toHaveLength(2); // 重拨成功——闭环
  });

  it("streamIdleTimeoutMs ≤ 0 关闭：直通分支不建计时器（正常流完成）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.fake.scripts.push(textScript("fine"));
    const made = await world.loop.create({ agent: { model: "fake-model", provider: "fake", streamIdleTimeoutMs: 0 } });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    made.value.agent.followup("hi");
    await made.value.agent.whenIdle();
    expect(made.value.agent.options.streamIdleTimeoutMs).toBe(0);
    expect(made.value.agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
  });
});
