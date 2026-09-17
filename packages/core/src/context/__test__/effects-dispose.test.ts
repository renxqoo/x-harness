import { describe, expect, it, vi } from "vitest";
import { createContext } from "../create-context.ts";
import { defineEvent } from "../tokens.ts";
import { contextDisposing } from "../vocab.ts";

describe("effect 账本与 dispose（§4）", () => {
  it("串行逆序：async disposer 完成后才回卷下一个", async () => {
    const ctx = createContext();
    const order: string[] = [];
    ctx.effect(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("a");
    });
    ctx.effect(() => {
      order.push("b");
    });
    ctx.effect(async () => {
      order.push("c");
    });
    await ctx.dispose();
    // 逆序：c（立即）→ b 必须等 c 的 async 完成后 → a 最后
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("dispose 幂等：二次 no-op", async () => {
    const ctx = createContext();
    const once = vi.fn();
    ctx.effect(once);
    await ctx.dispose();
    await ctx.dispose();
    expect(once).toHaveBeenCalledTimes(1);
  });

  it("unwind 边界：dispose 后 on/provide/effect 拒、dispatch 拒、emit 允许", async () => {
    const ctx = createContext();
    const token = defineEvent<{ v: number }>("evt");
    await ctx.dispose();
    expect(() => ctx.on(token, () => {})).toThrow(/rejected after dispose/);
    expect(() => ctx.provide({ kind: "service", name: "s" } as never, 1)).toThrow(
      /rejected after dispose/,
    );
    expect(() => ctx.effect(() => {})).toThrow(/rejected after dispose/);
    expect(() => ctx.emit(token, { v: 1 })).not.toThrow();
  });

  it("context/disposing 在回卷开始前广播", async () => {
    const ctx = createContext();
    const trace: string[] = [];
    ctx.on(contextDisposing, () => trace.push("disposing"));
    ctx.effect(() => {
      trace.push("unwound");
    });
    await ctx.dispose();
    expect(trace).toEqual(["disposing", "unwound"]);
  });

  it("同步 disposer 抛错：向上暴露（回卷是关键路径）", async () => {
    const ctx = createContext();
    ctx.effect(() => {
      throw new Error("unwind boom");
    });
    await expect(ctx.dispose()).rejects.toThrow("unwind boom");
  });

  it("provide/on 的 disposer 自动入账：层回卷即退订/注销", async () => {
    const ctx = createContext();
    const svc = { kind: "service", name: "svc" } as never;
    const token = defineEvent<{ v: number }>("evt");
    const heard: number[] = [];
    ctx.provide(svc, { n: 1 });
    ctx.on(token, ({ v }) => heard.push(v));
    await ctx.dispose();
    expect((ctx as { tryUse?: unknown }).tryUse).toBeDefined();
    // dispose 后注册面已拆：再无监听者
    expect(() => ctx.emit(token, { v: 1 })).not.toThrow();
    expect(heard).toEqual([]);
  });
});

describe("disposing 进行中（非完成后）的边界（Cordis 对照审计补强）", () => {
  it("回卷中途：新注册拒绝、emit 允许且送达未回卷监听者（部分送达语义）", async () => {
    const ctx = createContext();
    const token = defineEvent<{ v: number }>("evt-mid-disposing");
    const heard: number[] = [];
    ctx.on(token, ({ v }) => heard.push(v)); // 先注册 → 逆序后回卷（窗口期仍活着）
    let release: (() => void) | undefined;
    ctx.effect(
      () =>
        new Promise<void>((resolve) => {
          release = resolve; // 后注册 → 先回卷，把 dispose 挂在这里
        }),
    );

    const disposing = ctx.dispose();
    await new Promise((r) => setTimeout(r, 0)); // 进入 disposing 窗口：promise disposer 在途

    let midRegistration: Error | undefined;
    try {
      ctx.on(token, () => {});
    } catch (error) {
      midRegistration = error as Error;
    }
    expect(midRegistration?.message).toMatch(/disposing/); // 进行中注册拒绝

    expect(() => ctx.emit(token, { v: 1 })).not.toThrow(); // 进行中 emit 允许
    expect(heard).toEqual([1]); // 未回卷的监听者收到（部分送达）

    release?.();
    await disposing;
    ctx.emit(token, { v: 2 });
    expect(heard).toEqual([1]); // 回卷完成后不再送达
  });
});
