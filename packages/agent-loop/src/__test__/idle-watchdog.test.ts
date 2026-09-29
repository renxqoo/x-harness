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

function hangScript(text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    await new Promise<never>(() => {});
  })();
}

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
    expect(attempts).toHaveLength(1);
    const attemptEvent = attempts[0] as { data: { error?: string; content?: Array<{ type: string; text?: string }> } } | undefined;
    expect(attemptEvent).toBeDefined();
    if (attemptEvent !== undefined) {
      expect(String(attemptEvent.data.error)).toContain("network");
      expect(attemptEvent.data.content).toEqual([{ type: "text", text: "partial" }]);
    }
    expect(world.fake.calls).toHaveLength(2);
    const final = events.find((e) => e.type === "assistant/message");
    const blocks = ((final ?? { data: undefined }).data as unknown as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
    expect(blocks[0]?.text).toBe("recovered");
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
      setTimeout(resolve, 10);
    });
    made.value.agent.cancel("user");
    await made.value.agent.whenIdle();
    const events = made.value.agent.session.events();
    expect(events.at(-1)?.data).toMatchObject({ reason: { kind: "aborted" } });
    expect(world.fake.calls).toHaveLength(1);
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
    expect(record.aborted).toBe(true);
    expect(world.fake.calls).toHaveLength(2);
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
