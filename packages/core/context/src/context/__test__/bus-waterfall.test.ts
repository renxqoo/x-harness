import { describe, expect, it, vi } from "vitest";
import { createContext } from "../create-context.ts";
import { defineEvent, defineWaterfall } from "../tokens.ts";

describe("waterfall 派发（§2.2 第二行 + I2）", () => {
  it("洋葱次序：注册序包裹、final 最内层，回路逆序", async () => {
    const ctx = createContext();
    const token = defineWaterfall<number, number>("wf-onion");
    const trace: string[] = [];
    ctx.on(token, async (input, next) => {
      trace.push(`outer-in(${input})`);
      const out = await next(input + 1);
      trace.push(`outer-out(${out})`);
      return out;
    });
    ctx.on(token, async (input, next) => {
      trace.push(`inner-in(${input})`);
      const out = await next(input * 10);
      trace.push(`inner-out(${out})`);
      return out;
    });
    const result = await ctx.dispatch(token, 1, async (i) => {
      trace.push(`final(${i})`);
      return i;
    });
    expect(result).toBe(20);
    expect(trace).toEqual([
      "outer-in(1)",
      "inner-in(2)",
      "final(20)",
      "inner-out(20)",
      "outer-out(20)",
    ]);
  });

  it("无中间件直达 final", async () => {
    const ctx = createContext();
    const token = defineWaterfall<number, number>("wf-bare");
    const out = await ctx.dispatch(token, 5, async (i) => i + 1);
    expect(out).toBe(6);
  });

  it("中间件返回未调 next → throw", async () => {
    const ctx = createContext();
    const token = defineWaterfall<number, number>("wf-nocall");
    ctx.on(token, async (input) => input); // 吞链
    await expect(ctx.dispatch(token, 1, async (i) => i)).rejects.toThrow(
      "returned without calling next()",
    );
  });

  it("串行重调合法：settle 后再调，final 执行两次（重试机制基础）", async () => {
    const ctx = createContext();
    const token = defineWaterfall<number, number>("wf-retry");
    ctx.on(token, async (input, next) => {
      const first = await next(input); // settle
      if (first < 100) return next(input + 1); // 串行重调
      return first;
    });
    const final = vi.fn(async (i: number) => i * 10);
    const out = await ctx.dispatch(token, 1, final);
    expect(out).toBe(20);
    expect(final).toHaveBeenCalledTimes(2);
    expect(final).toHaveBeenNthCalledWith(1, 1);
    expect(final).toHaveBeenNthCalledWith(2, 2);
  });

  it("并发调用 next → throw（I2）", async () => {
    const ctx = createContext();
    const token = defineWaterfall<number, number>("wf-concurrent");
    let concurrent: Error | undefined;
    ctx.on(token, async (input, next) => {
      const first = next(input); // 未 settle
      try {
        next(input);
      } catch (error) {
        concurrent = error as Error;
      }
      return first;
    });
    const out = await ctx.dispatch(token, 1, async (i) => i * 10);
    expect(out).toBe(10);
    expect(concurrent?.message).toContain("concurrent next()");
  });

  it("中间件 throw → dispatch reject（关键路径错误必须暴露）", async () => {
    const ctx = createContext();
    const token = defineWaterfall<number, number>("wf-throw");
    ctx.on(token, async () => {
      throw new Error("middleware boom");
    });
    await expect(ctx.dispatch(token, 1, async (i) => i)).rejects.toThrow("middleware boom");
  });

  it("输入 deep 冻结：首个中间件见到即冻结，重调传入的新 input 冻结于 next", async () => {
    const ctx = createContext();
    const token = defineWaterfall<{ v: number }, number>("wf-freeze");
    const frozenFlags: boolean[] = [];
    ctx.on(token, async (input, next) => {
      frozenFlags.push(Object.isFrozen(input));
      return next({ v: input.v + 1 });
    });
    ctx.on(token, async (input, next) => {
      frozenFlags.push(Object.isFrozen(input));
      return next(input);
    });
    const out = await ctx.dispatch(token, { v: 1 }, async (i) => i.v);
    expect(out).toBe(2);
    expect(frozenFlags).toEqual([true, true]);
  });

  it("scope：子层中间件在链上可见（chain-up），兄弟层不可见", async () => {
    const ctx = createContext();
    const a = ctx.scope({ agentId: "a" });
    const b = ctx.scope({ agentId: "b" });
    const token = defineWaterfall<number, number>("wf-scope");
    a.on(token, async (i, next) => next(i + 1));
    b.on(token, async (i, next) => next(i + 100));
    const fromA = await a.dispatch(token, 1, async (i) => i);
    const fromRoot = await ctx.dispatch(token, 1, async (i) => i);
    expect(fromA).toBe(2); // a 自己 + 无 root 中间件
    expect(fromRoot).toBe(1); // root 派发看不见 a/b
    expect(await b.dispatch(token, 1, async (i) => i)).toBe(101);
  });

  it("token 类型不匹配与缺 final → 运行时拒", async () => {
    const ctx = createContext();
    const token = defineWaterfall<number, number>("wf-mismatch");
    await expect(ctx.dispatch(token as never, 1)).rejects.toThrow("requires a final");
    const eventLike = defineEvent<{ v: number }>("evt-like") as never;
    await expect(ctx.dispatch(eventLike, 1)).rejects.toThrow(
      "expects a waterfall/serial/guard token",
    );
  });
});
