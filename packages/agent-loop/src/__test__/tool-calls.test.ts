// 工具调度单元（docs/AGENT-LOOP-DRIVER §1.5）：真实 session+tools 装配；
// 排他屏障/并行池上限切分/model 序落账/abort 未启动合成/截断/args 解析/outcome 归集。

import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { Session } from "@x-harness/session";
import { Type } from "@sinclair/typebox";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolRegistry } from "@x-harness/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeToolCalls } from "../tool-calls.ts";
import type { ToolCallSpec } from "../tool-calls.ts";

interface Harness {
  ctx: Context;
  registry: ToolRegistry;
  session: Session;
  cleanup: () => Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

async function makeHarness(): Promise<Harness> {
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin]);
  const store = ctx.use(sessionStore);
  const made = await store.create();
  if (!made.ok) throw new Error(made.reason);
  return {
    ctx,
    registry: ctx.use(toolRegistry),
    session: made.value,
    cleanup: async () => {
      await ctx.dispose();
      void unload;
    },
  };
}

let harnesses: Harness[] = [];
beforeEach(() => {
  harnesses = [];
});
afterEach(async () => {
  for (const h of harnesses) await h.cleanup().catch(() => {});
});

function scheduler(h: Harness, over: Partial<Parameters<typeof executeToolCalls>[0]> = {}) {
  return (calls: readonly ToolCallSpec[]) =>
    executeToolCalls(
      {
        session: h.session,
        registry: h.registry,
        signal: new AbortController().signal,
        maxParallel: 10,
        maxResultChars: 100_000,
        turn: 0,
        step: 0,
        ...over,
      },
      calls,
    );
}

const spec = (callId: string, args: string): ToolCallSpec => ({ callId, name: "t", arguments: args });

describe("executeToolCalls（docs/AGENT-LOOP-DRIVER §1.5）", () => {
  it("排他屏障：无 isConcurrencySafe 的工具串行执行（前一个完成后下一个才 dispatch）", async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const order: string[] = [];
    h.registry.register({
      name: "t",
      inputSchema: Type.Object({ tag: Type.String() }),
      execute: async (args) => {
        const tag = (args as { tag: string }).tag;
        order.push(`start:${tag}`);
        await sleep(15);
        order.push(`end:${tag}`);
        return { content: tag };
      },
    });
    const collected = await scheduler(h)([spec("c1", '{"tag":"a"}'), spec("c2", '{"tag":"b"}')]);
    expect(collected.concludesTurn).toBe(false);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]); // 不交错
    const events = h.session.events();
    expect(events.filter((e) => e.type === "tool/call").map((e) => e.data.callId)).toEqual(["c1", "c2"]);
    expect(events.filter((e) => e.type === "tool/result").map((e) => e.data.callId)).toEqual(["c1", "c2"]);
  });

  it("并行池：连续 parallel 进池并发；完成乱序仍按 model 序落账", async () => {
    const h = await makeHarness();
    harnesses.push(h);
    let inFlight = 0;
    let peak = 0;
    h.registry.register({
      name: "t",
      inputSchema: Type.Object({ delayMs: Type.Integer() }),
      isConcurrencySafe: () => true,
      execute: async (args) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep((args as { delayMs: number }).delayMs);
        inFlight -= 1;
        return { content: `done` };
      },
    });
    // 乱序完成：第一个最慢
    const collected = await scheduler(h)([spec("c1", '{"delayMs":40}'), spec("c2", '{"delayMs":0}'), spec("c3", '{"delayMs":0}')]);
    expect(collected.additionalContexts).toEqual([]);
    expect(peak).toBe(3); // 全部并发
    const results = h.session.events().filter((e) => e.type === "tool/result");
    expect(results.map((e) => e.data.callId)).toEqual(["c1", "c2", "c3"]); // model 序，非完成序
  });

  it("并行池上限切分：maxParallel=2 时峰值不超过 2，三调用分两批", async () => {
    const h = await makeHarness();
    harnesses.push(h);
    let inFlight = 0;
    let peak = 0;
    h.registry.register({
      name: "t",
      inputSchema: Type.Object({}),
      isConcurrencySafe: () => true,
      execute: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(10);
        inFlight -= 1;
        return { content: "ok" };
      },
    });
    await scheduler(h, { maxParallel: 2 })([spec("c1", "{}"), spec("c2", "{}"), spec("c3", "{}")]);
    expect(peak).toBe(2);
    expect(h.session.events().filter((e) => e.type === "tool/result")).toHaveLength(3);
  });

  it("maxParallel=1：parallel 工具也逐个串行", async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const order: string[] = [];
    h.registry.register({
      name: "t",
      inputSchema: Type.Object({ tag: Type.String() }),
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const tag = (args as { tag: string }).tag;
        order.push(`start:${tag}`);
        await sleep(8);
        order.push(`end:${tag}`);
        return { content: tag };
      },
    });
    await scheduler(h, { maxParallel: 1 })([spec("c1", '{"tag":"a"}'), spec("c2", '{"tag":"b"}')]);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("池后跟排他工具：池并发执行、排他单独执行且序不交错；结果按 model 序", async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const trace: string[] = [];
    h.registry.register({
      name: "p",
      inputSchema: Type.Object({ tag: Type.String() }),
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const tag = (args as { tag: string }).tag;
        trace.push(`p:${tag}`);
        await sleep(10);
        return { content: tag };
      },
    });
    h.registry.register({
      name: "x",
      inputSchema: Type.Object({}),
      execute: async () => {
        trace.push("x:begin");
        await sleep(5);
        trace.push("x:end");
        return { content: "x" };
      },
    });
    await scheduler(h)([
      { callId: "c1", name: "p", arguments: '{"tag":"1"}' },
      { callId: "c2", name: "p", arguments: '{"tag":"2"}' },
      { callId: "c3", name: "x", arguments: "{}" },
    ]);
    expect(trace.slice(0, 2).sort()).toEqual(["p:1", "p:2"]); // 前两个并行同时开跑
    expect(trace[2]).toBe("x:begin"); // 池完成后排他才启动
    expect(trace[3]).toBe("x:end");
    const results = h.session.events().filter((e) => e.type === "tool/result");
    expect(results.map((e) => (e.data as { callId: string }).callId)).toEqual(["c1", "c2", "c3"]); // model 序
  });

  it("abort 未启动：合成 tool call aborted before dispatch，execute 不被调用", async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const execute = vi.fn(async () => ({ content: "should not run" }));
    h.registry.register({ name: "t", inputSchema: Type.Object({}), execute });
    const controller = new AbortController();
    controller.abort();
    const collected = await executeToolCalls(
      { session: h.session, registry: h.registry, signal: controller.signal, maxParallel: 10, maxResultChars: 1000, turn: 0, step: 0 },
      [spec("c1", "{}"), spec("c2", "{}")],
    );
    expect(execute).not.toHaveBeenCalled();
    expect(collected).toEqual({ concludesTurn: false, additionalContexts: [] });
    const results = h.session.events().filter((e) => e.type === "tool/result");
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.data).toMatchObject({ content: "tool call aborted before dispatch", isError: true });
    }
  });

  it("截断：超长 content 以 …[truncated] 尾标截断到 maxResultChars", async () => {
    const h = await makeHarness();
    harnesses.push(h);
    h.registry.register({ name: "t", inputSchema: Type.Object({}), execute: async () => ({ content: "abcdefghij" }) });
    await scheduler(h, { maxResultChars: 5 })([spec("c1", "{}")]);
    const result = h.session.events().find((e) => e.type === "tool/result");
    expect(result?.data).toMatchObject({ content: "abcde…[truncated]" });
  });

  it("args 解析：raw 空串 → {}；非法 JSON → 校验错误回显原文（isError）", async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const seen: unknown[] = [];
    h.registry.register({
      name: "t",
      inputSchema: Type.Object({}),
      execute: async (args) => {
        seen.push(args);
        return { content: "ok" };
      },
    });
    const collected = await scheduler(h)([spec("c1", "")]);
    expect(seen[0]).toEqual({}); // raw "" → {}
    expect(collected.concludesTurn).toBe(false);
    await scheduler(h)([spec("c2", "not-json")]);
    const results = h.session.events().filter((e) => e.type === "tool/result");
    expect(results[1]?.data).toMatchObject({ callId: "c2", isError: true });
    expect(String(results[1]?.data.content)).toContain("not-json"); // 违规回显让模型自纠
  });

  it("unknown tool：isError 结果成对落账，调度不中断", async () => {
    const h = await makeHarness();
    harnesses.push(h);
    await scheduler(h)([spec("c1", "{}")]);
    const events = h.session.events();
    expect(events.filter((e) => e.type === "tool/call")).toHaveLength(1);
    const result = events.find((e) => e.type === "tool/result");
    expect(result?.data).toMatchObject({ callId: "c1", isError: true });
  });

  it("outcome 归集：concludesTurn 与 additionalContexts（text 块）进 collected", async () => {
    const h = await makeHarness();
    harnesses.push(h);
    h.registry.register({
      name: "t",
      inputSchema: Type.Object({}),
      execute: async () => ({
        content: "done",
        concludesTurn: true,
        additionalContexts: [{ content: [{ type: "text" as const, text: "ctx-a" }] }, { content: [{ type: "text" as const, text: "ctx-b" }] }],
      }),
    });
    const collected = await scheduler(h)([spec("c1", "{}")]);
    expect(collected.concludesTurn).toBe(true);
    expect(collected.additionalContexts).toEqual([
      { type: "text", text: "ctx-a" },
      { type: "text", text: "ctx-b" },
    ]);
  });
});

describe("emitToolStream 发射面（BATCH2-DESIGN §2）", () => {
  it("并行池：onOutput 逐 callId 发射；abort 未启动合成结果零发射", async () => {
    const h = await makeHarness();
    harnesses.push(h);
    h.registry.register({
      name: "t",
      inputSchema: Type.Object({}),
      isConcurrencySafe: () => true,
      execute: async (_a, ctx) => {
        ctx.onOutput?.("d1");
        ctx.onOutput?.("d2");
        return { content: "ok" };
      },
    });
    const seen: string[] = [];
    await scheduler(h, { emitToolStream: (callId, delta) => seen.push(`${callId}:${delta}`) })([spec("c1", "{}"), spec("c2", "{}")]);
    expect([...seen].sort()).toEqual(["c1:d1", "c1:d2", "c2:d1", "c2:d2"]);
    const controller = new AbortController();
    controller.abort();
    const abortedSeen: string[] = [];
    await executeToolCalls(
      {
        session: h.session,
        registry: h.registry,
        signal: controller.signal,
        maxParallel: 10,
        maxResultChars: 100_000,
        turn: 0,
        step: 0,
        emitToolStream: (callId, delta) => abortedSeen.push(`${callId}:${delta}`),
      },
      [spec("c3", "{}")],
    );
    expect(abortedSeen).toEqual([]);
  });

  it("排他路径同携 onOutput；发射面 throw 不杀工具结果（回归 BATCH2 审 M3）", async () => {
    const h = await makeHarness();
    harnesses.push(h);
    h.registry.register({
      name: "ex",
      inputSchema: Type.Object({}),
      execute: async (_a, ctx) => {
        ctx.onOutput?.("delta-1");
        return { content: "exclusive-ok" };
      },
    });
    const seen: string[] = [];
    await scheduler(h, {
      emitToolStream: (callId, delta) => {
        seen.push(`${callId}:${delta}`);
        throw new Error("emitter bug");
      },
    })([{ callId: "c9", name: "ex", arguments: "{}" }]);
    expect(seen).toEqual(["c9:delta-1"]);
    const result = h.session.events().find((e) => e.type === "tool/result");
    expect(result && result.type === "tool/result" ? result.data.content : "").toContain("exclusive-ok");
  });
});
