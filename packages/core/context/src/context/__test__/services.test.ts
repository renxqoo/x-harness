import { describe, expect, it, vi } from "vitest";
import { createContext } from "../create-context.ts";
import { defineService } from "../tokens.ts";
import { serviceProvided } from "../vocab.ts";

interface Counter {
  n: number;
}

describe("服务注册表（§1）", () => {
  it("provide 返回 disposer，退订后 use 抛、tryUse undefined", () => {
    const ctx = createContext();
    const token = defineService<Counter>("counter");
    const stop = ctx.provide(token, { n: 0 });
    expect(ctx.use(token).n).toBe(0);
    stop();
    expect(ctx.tryUse(token)).toBeUndefined();
    expect(() => ctx.use(token)).toThrow(/counter.*not provided/);
  });

  it("同层重复 provide 同 token throw", () => {
    const ctx = createContext();
    const token = defineService<Counter>("counter");
    ctx.provide(token, { n: 0 });
    expect(() => ctx.provide(token, { n: 1 })).toThrow("already provided on this layer");
  });

  it("provide 非服务 token → 运行时拒", () => {
    const ctx = createContext();
    const fake = { kind: "event", name: "x" } as never;
    expect(() => ctx.provide(fake, 1)).toThrow("expects a service token");
  });

  it("use 沿 scope 链 nearest-first 遮蔽（§3）", () => {
    const ctx = createContext();
    const token = defineService<Counter>("counter");
    ctx.provide(token, { n: 0 });
    const child = ctx.scope({ agentId: "a" });
    expect(child.use(token).n).toBe(0);
    child.provide(token, { n: 1 });
    expect(child.use(token).n).toBe(1);
    expect(ctx.use(token).n).toBe(0);
  });

  it("provide 广播 service/provided（提供层 chain-up：祖先听见、兄弟不可见——C3）", () => {
    const rootHeard: string[] = [];
    const siblingHeard: string[] = [];
    const ctx = createContext();
    const rootToken = defineService<Counter>("root-counter");
    ctx.on(serviceProvided, ({ service }) => rootHeard.push(service));
    const sibling = ctx.scope({ agentId: "sib" });
    sibling.on(serviceProvided, ({ service }) => siblingHeard.push(service));

    ctx.provide(rootToken, { n: 0 });
    expect(rootHeard).toEqual(["root-counter"]);
    expect(siblingHeard).toEqual([]);

    const childToken = defineService<Counter>("child-counter");
    const child = ctx.scope({ agentId: "child" });
    child.provide(childToken, { n: 0 });
    expect(rootHeard).toEqual(["root-counter", "child-counter"]);
  });

  it("disposer 手动调用与层回卷幂等（I1）", async () => {
    const ctx = createContext();
    const token = defineService<Counter>("counter");
    const stop = ctx.provide(token, { n: 0 });
    stop();
    stop();
    await ctx.dispose();
    expect(ctx.tryUse(token)).toBeUndefined();
  });

  it("晚退订的 provide 不影响后来者", () => {
    const ctx = createContext();
    const token = defineService<Counter>("counter");
    const first = { n: 1 };
    const stop = ctx.provide(token, first);
    stop();
    ctx.provide(token, { n: 2 });
    expect(ctx.use(token).n).toBe(2);
  });

  it("sink 收到 provide 抛错？——不适用：provide 抛错直接向上（装配错误 fail-fast）", () => {
    const sink = vi.fn();
    const ctx = createContext({ onListenerError: sink });
    const token = defineService<Counter>("counter");
    ctx.provide(token, { n: 0 });
    expect(sink).not.toHaveBeenCalled();
  });
});
