import { describe, expect, it } from "vitest";
import { createContext } from "../create-context.ts";
import type { Chain } from "../types.ts";

describe("匿名链（§6.2 / C10）", () => {
  it("dispatch 穿过中间件到达 final（铸造时绑定）", async () => {
    const ctx = createContext();
    const chain = ctx.createChain<number, number>(async (i) => i * 2);
    expect(await chain.dispatch(1)).toBe(2);
  });

  it("onChain 中间件包裹 final，多层按注册序", async () => {
    const ctx = createContext();
    const chain = ctx.createChain<number, number>(async (i) => i * 2);
    ctx.onChain(chain, async (i, next) => next(i + 1));
    ctx.onChain(chain, async (i, next) => next(i + 10));
    // ((1+1)+10)*2
    expect(await chain.dispatch(1)).toBe(24);
  });

  it("层归属消费方：消费方层 dispose 后中间件移除（I1 闭合）", async () => {
    const ctx = createContext();
    const chain = ctx.createChain<number, number>(async (i) => i * 2);
    const consumer = ctx.scope({ agentId: "consumer" });
    consumer.onChain(chain, async (i, next) => next(i + 1));
    expect(await chain.dispatch(1)).toBe(4);
    await consumer.dispose();
    expect(await chain.dispatch(1)).toBe(2);
  });

  it("链不随 owner 层回卷，仅 onChain 注册随消费方回卷（IMPL 裁决 3）", async () => {
    const ctx = createContext();
    const ownerLayer = ctx.scope({ agentId: "owner" });
    const chain = ownerLayer.createChain<number, number>(async (i) => i * 2);
    const consumer = ctx.scope({ agentId: "consumer" });
    consumer.onChain(chain, async (i, next) => next(i + 1));
    expect(await chain.dispatch(1)).toBe(4);
    await ownerLayer.dispose(); // owner 层回卷不回收链对象
    expect(await chain.dispatch(1)).toBe(4); // 链与消费方注册都在
    await consumer.dispose();
    expect(await chain.dispatch(1)).toBe(2); // 只剩链本身
  });

  it("onChain 拒绝非 createChain 产物", () => {
    const ctx = createContext();
    const fake = { dispatch: async () => 1 } as Chain<number, number>;
    expect(() => ctx.onChain(fake, async (i, next) => next(i))).toThrow(
      "expects a chain created by createChain",
    );
  });

  it("输入深冻结（与 waterfall 同律，IMPL 裁决 6/7）", async () => {
    const ctx = createContext();
    const chain = ctx.createChain<{ v: number }, number>(async (i) => i.v);
    let frozen = false;
    ctx.onChain(chain, async (input, next) => {
      frozen = Object.isFrozen(input);
      return next(input);
    });
    await chain.dispatch({ v: 1 });
    expect(frozen).toBe(true);
  });
});
