import { describe, expect, it, vi } from "vitest";
import { createContext } from "../create-context.ts";
import { defineGuard, defineSerial } from "../tokens.ts";

const deny = (reason: string) => ({ kind: "deny" as const, reason });

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe("serial 派发（§2.2 第三行）", () => {
  it("注册序逐个 await，全部执行不短路", async () => {
    const ctx = createContext();
    const token = defineSerial<{ v: number }>("ser-order");
    const order: number[] = [];
    ctx.on(token, async ({ v }) => {
      await sleep(5);
      order.push(v * 1);
    });
    ctx.on(token, ({ v }) => order.push(v * 2));
    await ctx.dispatch(token, { v: 1 });
    expect(order).toEqual([1, 2]); // 后注册的等前一个 await 完成
  });

  it("监听器错误隔离：进 sink、后续继续", async () => {
    const sink = vi.fn();
    const ctx = createContext({ onListenerError: sink });
    const token = defineSerial<{ v: number }>("ser-iso");
    const later = vi.fn();
    ctx.on(token, async () => {
      throw new Error("boom");
    });
    ctx.on(token, later);
    await ctx.dispatch(token, { v: 1 });
    expect(later).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("payload 深冻结", async () => {
    const ctx = createContext();
    const token = defineSerial<{ nested: { x: number } }>("ser-freeze");
    let seen: { nested: { x: number } } | undefined;
    ctx.on(token, (p) => {
      seen = p;
    });
    await ctx.dispatch(token, { nested: { x: 1 } });
    expect(Object.isFrozen(seen?.nested)).toBe(true);
  });
});

describe("guard 派发（§2.2 第四行 + C7：全部执行不短路）", () => {
  it("无 deny → undefined", async () => {
    const ctx = createContext();
    const token = defineGuard<{ v: number }>("grd-pass");
    ctx.on(token, () => undefined);
    await expect(ctx.dispatch(token, { v: 1 })).resolves.toBeUndefined();
  });

  it("首个 deny（按注册序）胜出，且 deny 之后全部注册者仍执行（消歧后的语义）", async () => {
    const ctx = createContext();
    const token = defineGuard<{ v: number }>("grd-first");
    const executed: string[] = [];
    ctx.on(token, () => {
      executed.push("first");
    });
    ctx.on(token, () => {
      executed.push("second");
      return deny("no");
    });
    ctx.on(token, () => {
      executed.push("third");
      return deny("also-no");
    });
    const verdict = await ctx.dispatch(token, { v: 1 });
    expect(executed).toEqual(["first", "second", "third"]); // 不短路
    expect(verdict).toEqual({ kind: "deny", reason: "no" }); // 首个按序
  });

  it("坏守卫按弃权计：错误进 sink，不影响他人与其后 deny", async () => {
    const sink = vi.fn();
    const ctx = createContext({ onListenerError: sink });
    const token = defineGuard<{ v: number }>("grd-broken");
    ctx.on(token, async () => {
      throw new Error("guard boom");
    });
    ctx.on(token, () => deny("legit"));
    const verdict = await ctx.dispatch(token, { v: 1 });
    expect(verdict).toEqual({ kind: "deny", reason: "legit" });
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("payload 深冻结", async () => {
    const ctx = createContext();
    const token = defineGuard<{ nested: { x: number } }>("grd-freeze");
    let seen: { nested: { x: number } } | undefined;
    ctx.on(token, (p) => {
      seen = p;
    });
    await ctx.dispatch(token, { nested: { x: 1 } });
    expect(Object.isFrozen(seen?.nested)).toBe(true);
  });

  it("sync 与 async 守卫混合按序执行", async () => {
    const ctx = createContext();
    const token = defineGuard<{ v: number }>("grd-mixed");
    const order: string[] = [];
    ctx.on(token, async () => {
      await sleep(5);
      order.push("async");
      return deny("async-deny");
    });
    ctx.on(token, () => {
      order.push("sync");
      return deny("sync-deny");
    });
    const verdict = await ctx.dispatch(token, { v: 1 });
    expect(order).toEqual(["async", "sync"]); // 逐个 await
    expect(verdict).toEqual({ kind: "deny", reason: "async-deny" }); // 首个按序
  });
});
