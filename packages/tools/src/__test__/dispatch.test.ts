// dispatch 管线单元（docs/TOOLS.md §1.3 六段 + §7 路径矩阵）：stub 两段派发直击管线逻辑。

import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { createDispatcher } from "../dispatch.ts";
import { createToolRegistry } from "../registry.ts";
import type { PreExecuteDecision, ToolCallRequest, ToolOutcome } from "../types.ts";

function makeWorld(preExecute?: (payload: unknown) => Promise<unknown>) {
  const registry = createToolRegistry();
  const dispatch = createDispatcher({
    registry,
    dispatchPreExecute: (payload) =>
      preExecute ? (preExecute(payload) as Promise<PreExecuteDecision>) : Promise.resolve({ kind: "allow" }),
    dispatchExecute: (request, final) => final(request),
  });
  return { registry, dispatch };
}

const call = (name: string, args: unknown = {}, signal?: AbortSignal): ToolCallRequest => ({
  callId: "c1",
  name,
  args,
  signal: signal ?? new AbortController().signal,
});

describe("dispatch 路径矩阵（docs/TOOLS.md §7）", () => {
  it("形状守卫：缺 signal / 缺 name / 非 callId → invalid-request", async () => {
    const { dispatch } = makeWorld();
    expect(await dispatch({ callId: "c", name: "t", args: {}, signal: undefined as never })).toEqual({
      content: "invalid-request",
      isError: true,
    });
    expect(await dispatch({ callId: "c", name: 5 as never, args: {}, signal: new AbortController().signal })).toEqual({
      content: "invalid-request",
      isError: true,
    });
  });

  it("先 abort → aborted 判别 outcome（连 unknown-tool 都不查）", async () => {
    const { dispatch } = makeWorld();
    const controller = new AbortController();
    controller.abort();
    const outcome = await dispatch(call("nope", {}, controller.signal));
    expect(outcome).toEqual({ content: "aborted", isError: true, aborted: true });
  });

  it("unknown-tool → 模型可读错误", async () => {
    const { dispatch } = makeWorld();
    expect(await dispatch(call("nope"))).toEqual({ content: "unknown-tool:nope", isError: true });
  });

  it("deny → denied:<reason>", async () => {
    const { registry, dispatch } = makeWorld(async () => ({ kind: "deny", reason: "quota" }));
    registry.register({ name: "t", inputSchema: Type.Object({}), execute: async () => ({ content: "ok" }) });
    expect(await dispatch(call("t"))).toEqual({ content: "denied:quota", isError: true });
  });

  it("垃圾决策（调过链后返回非判别形态）→ denied:invalid-decision（fail-closed）", async () => {
    const { registry, dispatch } = makeWorld(async () => "garbage");
    registry.register({ name: "t", inputSchema: Type.Object({}), execute: async () => ({ content: "ok" }) });
    expect(await dispatch(call("t"))).toEqual({ content: "denied:invalid-decision", isError: true });
  });

  it("校验违规 → 违规清单 + received 回显（含字符串原文 args）", async () => {
    const { registry, dispatch } = makeWorld();
    registry.register({
      name: "t",
      inputSchema: Type.Object({ path: Type.String() }),
      execute: async () => ({ content: "ok" }),
    });
    const outcome = await dispatch(call("t", { path: 5 }));
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("/path");
    expect(outcome.content).toContain('received: {"path":5}');
    const raw = await dispatch(call("t", "{bad json"));
    expect(raw.isError).toBe(true);
    expect(raw.content).toContain("received: \"{bad json\"");
  });

  it("正常路径：execute 收到校验后的 args 与可用 signal（冻结断言在 plugin.test 真实管线）", async () => {
    const { registry, dispatch } = makeWorld();
    let seen: { args?: unknown; signal?: AbortSignal } = {};
    registry.register({
      name: "t",
      inputSchema: Type.Object({ n: Type.Integer() }),
      execute: async (args, ctx) => {
        seen = { args, signal: ctx.signal };
        return { content: "ok" };
      },
    });
    const outcome = await dispatch(call("t", { n: 1 }));
    expect(outcome).toEqual({ content: "ok" });
    expect(seen.args).toEqual({ n: 1 });
    expect(() => seen.signal?.throwIfAborted()).not.toThrow();
  });

  it("execute 抛错 → 归一化消息；不可打印抛出值兜底", async () => {
    const { registry, dispatch } = makeWorld();
    registry.register({
      name: "boom",
      inputSchema: Type.Object({}),
      execute: async () => {
        throw new Error("E66");
      },
    });
    expect(await dispatch(call("boom"))).toEqual({ content: "E66", isError: true });
    const hostile = Symbol("s");
    registry.register({
      name: "hostile",
      inputSchema: Type.Object({}),
      execute: async () => {
        throw hostile;
      },
    });
    expect(await dispatch(call("hostile"))).toEqual({ content: "Symbol(s)", isError: true });
  });

  it("执行中/后 abort → aborted 覆盖（含正常返回遇 abort：success superseded）", async () => {
    const { registry, dispatch } = makeWorld();
    const controller = new AbortController();
    registry.register({
      name: "throw-after-abort",
      inputSchema: Type.Object({}),
      execute: async () => {
        controller.abort();
        throw new Error("downstream");
      },
    });
    expect(await dispatch(call("throw-after-abort", {}, controller.signal))).toEqual({
      content: "aborted",
      isError: true,
      aborted: true,
    });
    registry.register({
      name: "return-after-abort",
      inputSchema: Type.Object({}),
      execute: async () => {
        controller.abort();
        return { content: "late" };
      },
    });
    const fresh = new AbortController();
    fresh.abort();
    const outcome = await dispatch(call("return-after-abort", {}, fresh.signal));
    expect(outcome).toEqual({ content: "aborted", isError: true, aborted: true });
  });
});

describe("outcome 形状门矩阵（docs/TOOLS.md §1.3）", () => {
  it.each<[string, unknown, ToolOutcome | undefined]>([
    ["非对象（undefined）", undefined, { content: "invalid-tool-output", isError: true }],
    ["非对象（字符串）", "ok", { content: "invalid-tool-output", isError: true }],
    ["content 非 string", { content: 5 }, { content: "invalid-tool-output", isError: true }],
    ["isError 显式 false", { content: "x", isError: false as never }, { content: "invalid-tool-output", isError: true }],
    ["concludesTurn 显式 false", { content: "x", concludesTurn: false as never }, { content: "invalid-tool-output", isError: true }],
    ["additionalContexts 含 tool_use 块", { content: "x", additionalContexts: [{ content: [{ type: "tool_use", callId: "c", name: "n", input: "{}" } as never] }] }, { content: "invalid-tool-output", isError: true }],
  ])("%s → invalid-tool-output", async (_name, executeReturn, expected) => {
    const { registry, dispatch } = makeWorld();
    registry.register({ name: "t", inputSchema: Type.Object({}), execute: async () => executeReturn as ToolOutcome });
    expect(await dispatch(call("t"))).toEqual(expected);
  });

  it("空串 / 空数组 / 未知字段 / isError+concludesTurn 并存均合法，白名单构造", async () => {
    const { registry, dispatch } = makeWorld();
    registry.register({
      name: "t",
      inputSchema: Type.Object({}),
      execute: async () => ({
        content: "",
        isError: true,
        concludesTurn: true,
        additionalContexts: [],
        extra: "私有字段",
      } as unknown as ToolOutcome),
    });
    const outcome = await dispatch(call("t"));
    expect(outcome).toEqual({ content: "", isError: true, concludesTurn: true, additionalContexts: [] });
    expect("extra" in outcome).toBe(false); // 白名单构造：未知字段放行但不透传
  });

  it("hostile content getter → invalid-tool-output 而非 internal（F6 回归）", async () => {
    const { registry, dispatch } = makeWorld();
    registry.register({
      name: "t",
      inputSchema: Type.Object({}),
      execute: async () =>
        ({
          get content(): string {
            throw new Error("getter-boom");
          },
        }) as never,
    });
    expect(await dispatch(call("t"))).toEqual({ content: "invalid-tool-output", isError: true });
  });

  it("additionalContexts 合法 text 块透传", async () => {
    const { registry, dispatch } = makeWorld();
    registry.register({
      name: "t",
      inputSchema: Type.Object({}),
      execute: async () => ({ content: "x", additionalContexts: [{ content: [{ type: "text", text: "ctx" }] }] }),
    });
    expect(await dispatch(call("t"))).toEqual({
      content: "x",
      additionalContexts: [{ content: [{ type: "text", text: "ctx" }] }],
    });
  });
});
