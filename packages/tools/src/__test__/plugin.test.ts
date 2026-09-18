// toolsPlugin 装配集成（docs/TOOLS.md §7 管线交互 + token 词表 + 注册方 effect 绑定模式）。

import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Context, Disposer } from "@x-harness/core";
import { defineTool, toolRegistry, toolsExecute, toolsPreExecute, toolsPlugin } from "../index.ts";
import type { PreExecuteDecision, ToolOutcome, ToolRegistry } from "../types.ts";

type PrePayload = { readonly callId: string; readonly name: string; readonly args: unknown };

const call = (name: string, args: unknown = {}): { callId: string; name: string; args: unknown; signal: AbortSignal } => ({
  callId: "c1",
  name,
  args,
  signal: new AbortController().signal,
});

async function assemble(): Promise<{ ctx: Context; tools: ToolRegistry; unload: readonly Disposer[] }> {
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [toolsPlugin]);
  return { ctx, tools: ctx.use(toolRegistry), unload };
}

const echo = defineTool({
  name: "echo",
  description: "回显",
  inputSchema: Type.Object({ text: Type.String() }),
  execute: async (args) => ({ content: args.text }),
});

describe("token 词表（docs/TOOLS.md §7）", () => {
  it("3 token：service + 2 waterfall，名与模式锁定", () => {
    expect(toolRegistry).toMatchObject({ kind: "service", name: "tool-registry" });
    expect(toolsPreExecute).toMatchObject({ kind: "waterfall", mode: "waterfall", name: "tools/pre-execute" });
    expect(toolsExecute).toMatchObject({ kind: "waterfall", mode: "waterfall", name: "tools/execute" });
  });
});

describe("装配与注册方 effect 绑定模式（docs/TOOLS.md §1.2）", () => {
  it("注册 → dispatch → schemas；消费方 effect 绑定演示", async () => {
    const { ctx, tools } = await assemble();
    const off = tools.register(echo);
    ctx.effect(off); // 注册方契约：绑定到自身层，插件回卷时随层注销
    expect(await tools.dispatch(call("echo", { text: "hi" }))).toEqual({ content: "hi" });
    expect(tools.schemas()[0]?.name).toBe("echo");
    await ctx.dispose();
  });

  it("defineTool 的 Static 推断：类型安全参数直达 execute", async () => {
    const { tools } = await assemble();
    const typed = defineTool({
      name: "typed",
      inputSchema: Type.Object({ n: Type.Integer() }),
      execute: async (args) => ({ content: String(args.n + 1) }),
    });
    tools.register(typed);
    expect(await tools.dispatch(call("typed", { n: 41 }))).toEqual({ content: "42" });
  });
});

describe("管线交互（docs/TOOLS.md §7）", () => {
  it("pre-execute 中间件调 next 后返回 deny（最外层胜；内核 I2 必须调 next）", async () => {
    const { ctx, tools } = await assemble();
    const offOuter = ctx.on(toolsPreExecute, async (payload: PrePayload, next: (input: PrePayload) => Promise<PreExecuteDecision>): Promise<PreExecuteDecision> => {
      await next(payload);
      return { kind: "deny", reason: "outer" };
    });
    const offInner = ctx.on(toolsPreExecute, async (payload: PrePayload, next: (input: PrePayload) => Promise<PreExecuteDecision>) => next(payload));
    tools.register(echo);
    expect(await tools.dispatch(call("echo", { text: "x" }))).toEqual({ content: "denied:outer", isError: true });
    offOuter();
    expect(await tools.dispatch(call("echo", { text: "x" }))).toEqual({ content: "x" });
    offInner();
  });

  it("pre-execute 中间件不调 next（内核 I2 违规）→ 逃逸归一化 internal outcome，dispatch 不 reject", async () => {
    const { ctx, tools } = await assemble();
    const off = ctx.on(toolsPreExecute, async () => ({ kind: "deny", reason: "illegal" }) as never);
    tools.register(echo);
    const outcome = await tools.dispatch(call("echo", { text: "x" }));
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("internal:");
    off();
  });

  it("execute 中间件换 signal（超时模式）→ 慢工具 aborted 判别", async () => {
    const { ctx, tools } = await assemble();
    const off = ctx.on(toolsExecute, async (request, next) =>
      next({ ...request, signal: AbortSignal.timeout(5) }),
    );
    tools.register({
      name: "slow",
      inputSchema: Type.Object({}),
      execute: async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        return { content: "late" };
      },
    });
    expect(await tools.dispatch(call("slow"))).toEqual({ content: "aborted", isError: true, aborted: true });
    off();
  });

  it("execute 中间件后处理 outcome（重写 content）+ 冻结载荷回归（真实管线）", async () => {
    const { ctx, tools } = await assemble();
    let frozenArgs = false;
    let signalUsable = false;
    tools.register({
      name: "probe",
      inputSchema: Type.Object({ text: Type.String() }),
      execute: async (args, execCtx) => {
        frozenArgs = Object.isFrozen(args);
        execCtx.signal.throwIfAborted();
        signalUsable = true;
        return { content: "ok" };
      },
    });
    const off = ctx.on(toolsExecute, async (request, next) => {
      const outcome = await next(request);
      return { ...outcome, content: `[wrapped] ${outcome.content}` };
    });
    expect(await tools.dispatch(call("probe", { text: "hi" }))).toEqual({ content: "[wrapped] ok" });
    expect(frozenArgs).toBe(true); // 内核 deepFreeze 载荷——工具作者只读契约（真实管线验证）
    expect(signalUsable).toBe(true); // 冻结不破坏 AbortSignal 内部槽
    off();
  });

  it("execute 中间件自身 throw → 逃逸归一化 internal outcome", async () => {
    const { ctx, tools } = await assemble();
    const off = ctx.on(toolsExecute, async () => {
      throw new Error("middleware-bug");
    });
    tools.register(echo);
    expect(await tools.dispatch(call("echo", { text: "x" }))).toEqual({
      content: "internal:middleware-bug",
      isError: true,
    });
    off();
  });

  it("concurrencyOf 经服务可达且 fail-closed", async () => {
    const { tools } = await assemble();
    tools.register(
      defineTool({
        name: "safe",
        inputSchema: Type.Object({}),
        isConcurrencySafe: () => true,
        execute: async () => ({ content: "ok" }),
      }),
    );
    tools.register(echo);
    expect(tools.concurrencyOf("safe", {})).toBe("parallel");
    expect(tools.concurrencyOf("echo", {})).toBe("exclusive");
    expect(tools.concurrencyOf("missing", {})).toBe("exclusive");
  });

  it("hostile toString 的逃逸抛出值 → internal:<unprintable>，dispatch 不 reject（F1 回归）", async () => {
    const { ctx, tools } = await assemble();
    tools.register(echo);
    const off = ctx.on(toolsExecute, () => {
      throw { toString() { throw new Error("hostile-toString-boom"); } };
    });
    expect(await tools.dispatch(call("echo", { text: "x" }))).toEqual({
      content: "internal:<unprintable thrown value>",
      isError: true,
    });
    off();
  });

  it("中间件换 args/name → request-altered（F3 回归：击穿校验先行的契约）", async () => {
    const { ctx, tools } = await assemble();
    tools.register(
      defineTool({
        name: "typed",
        inputSchema: Type.Object({ n: Type.Integer() }),
        execute: async (args) => ({ content: String(args.n) }),
      }),
    );
    const offArgs = ctx.on(toolsExecute, async (request, next) => next({ ...request, args: { n: "EVIL" } }));
    expect(await tools.dispatch(call("typed", { n: 1 }))).toEqual({ content: "request-altered", isError: true });
    offArgs();
    const offName = ctx.on(toolsExecute, async (request, next) => next({ ...request, name: "other" }));
    expect(await tools.dispatch(call("typed", { n: 1 }))).toEqual({ content: "request-altered", isError: true });
    offName();
  });

  it("注册即深冻：事后 mutate def/schema 抛出且注册表不变（F5 回归）", async () => {
    const { tools } = await assemble();
    const def = defineTool({
      name: "frozen",
      inputSchema: Type.Object({ a: Type.String() }),
      execute: async () => ({ content: "ok" }),
    });
    tools.register(def);
    expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(def.inputSchema)).toBe(true);
    expect(() => {
      (def as unknown as { execute: unknown }).execute = async () => ({ content: "hacked" });
    }).toThrow();
    expect(await tools.dispatch(call("frozen", { a: "x" }))).toEqual({ content: "ok" });
  });

  it("TypeBox schema 序列化为纯 JSON Schema（符号修饰键丢弃）——LLM 传输兼容", async () => {
    const { tools } = await assemble();
    tools.register(
      defineTool({
        name: "s",
        inputSchema: Type.Object({ a: Type.Optional(Type.String()) }),
        execute: async () => ({ content: "ok" as string }) as ToolOutcome,
      }),
    );
    const schema = tools.schemas()[0]?.inputSchema as unknown;
    const text = JSON.stringify(schema);
    expect(text).toContain('"type":"object"');
    expect(text).toContain('"a"');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
