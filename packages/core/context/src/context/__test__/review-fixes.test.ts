import { describe, expect, it, vi } from "vitest";
import { deepFreeze } from "../freeze.ts";
import { createContext } from "../create-context.ts";
import { loadPlugins } from "../load-plugins.ts";
import { defineEvent, defineGuard, defineSerial, defineService, defineWaterfall } from "../tokens.ts";
import type { Plugin } from "../types.ts";
import { serviceProvided } from "../vocab.ts";

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const noop = (): void => {};

let zombieNextError: Error | undefined;
function fireZombieNext(next: (input: number) => Promise<number>, input: number): void {
  setTimeout(() => {
    try {
      next(input);
    } catch (error) {
      zombieNextError = error as Error;
    }
  }, 0);
}

describe("审查 #1：disposer 抛错不中止回卷（I1 优先），错误聚合上抛", () => {
  it("单个 disposer 抛错：后续仍回卷、层推进到 disposed、错误上抛", async () => {
    const ctx = createContext();
    const order: string[] = [];
    ctx.effect(() => {
      order.push("first");
    });
    ctx.effect(() => {
      throw new Error("boom");
    });
    ctx.effect(() => {
      order.push("last");
    });
    await expect(ctx.dispose()).rejects.toThrow("boom");
    expect(order).toEqual(["last", "first"]);
  });

  it("多个 disposer 抛错 → AggregateError；层状态 disposed、二次 dispose no-op", async () => {
    const ctx = createContext();
    const after = vi.fn();
    ctx.effect(() => {
      throw new Error("a");
    });
    ctx.effect(() => {
      throw new Error("b");
    });
    ctx.effect(after);
    const caught = await ctx.dispose().catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(2);
    expect(after).toHaveBeenCalledTimes(1);
    await expect(ctx.dispose()).resolves.toBeUndefined();
    expect(() => ctx.effect(noop)).toThrow(/disposed/);
  });
});

describe("审查 #2：deepFreeze 预冻结外壳不阻断子代递归；环引用安全", () => {
  it("预冻结外壳 + 活子代 → 子代也被冻结", () => {
    const nested = { x: 1 };
    const shell = Object.freeze({ nested });
    const payload = deepFreeze({ shell });
    expect(Object.isFrozen(payload.shell)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
  });

  it("环引用不栈溢出", () => {
    const a: { self?: unknown; peer?: unknown } = {};
    const b: { peer?: unknown } = {};
    a.self = a;
    a.peer = b;
    b.peer = a;
    expect(() => deepFreeze(a)).not.toThrow();
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
  });
});

describe("审查 #5：disposer 自清理——手动退订后层回卷不再重复执行", () => {
  it("on 的手动退订：disposer 幂等且注册表不再执行", async () => {
    const ctx = createContext();
    const token = defineEvent<{ v: number }>("evt");
    const heard: number[] = [];
    const stop = ctx.on(token, ({ v }) => heard.push(v));
    stop();
    stop();
    ctx.emit(token, { v: 1 });
    await ctx.dispose();
    ctx.emit(token, { v: 2 });
    expect(heard).toEqual([]);
  });
});

describe("审查 #6：provide 先入账后广播——监听器内触发 dispose 也能回卷本注册", () => {
  it("service/provided 监听器 dispose 整层：该 provide 被回卷", async () => {
    const ctx = createContext();
    const token = defineService<{ n: number }>("svc-race");
    ctx.on(serviceProvided, () => {
      void ctx.dispose();
    });
    ctx.provide(token, { n: 1 });
    expect(ctx.tryUse(token)).toBeUndefined();
    expect(() => ctx.use(token)).toThrow(/not provided/);
  });
});

describe("审查 #7：伪造 token 形状运行时拒；guard 垃圾返回值按弃权", () => {
  it("缺 mode 的伪 token 经 on 拒收", () => {
    const ctx = createContext();
    const fake = { kind: "serial", name: "x" } as never;
    expect(() => ctx.on(fake, noop)).toThrow("expects an event-like token");
  });

  it("缺 freeze 的伪 event token 经 emit 拒收", () => {
    const ctx = createContext();
    const fake = { kind: "event", mode: "emit", name: "x" } as never;
    expect(() => ctx.emit(fake, {})).toThrow("invalid event token shape");
  });

  it("guard 返回垃圾真值（非 deny 形状）按弃权计", async () => {
    const ctx = createContext();
    const token = defineGuard<{ v: number }>("grd-garbage");
    ctx.on(token, () => 42 as unknown as void);
    ctx.on(token, () => ({ kind: "deny" as const, reason: "legit" }));
    const verdict = await ctx.dispatch(token, { v: 1 });
    expect(verdict).toEqual({ kind: "deny", reason: "legit" });
  });
});

describe("审查 #8：provide(undefined) 不穿透 nearest-first 遮蔽", () => {
  it("子层 undefined 遮蔽父层同 token", () => {
    const ctx = createContext();
    const token = defineService<{ n: number }>("svc-shadow");
    ctx.provide(token, { n: 1 });
    const child = ctx.scope({ agentId: "a" });
    child.provide(token, undefined as unknown as { n: number });
    expect(child.use(token)).toBeUndefined();
    expect(ctx.use(token)).toEqual({ n: 1 });
  });
});

describe("审查 #9：loadPlugins 失败路径 dispose 也抛 → 仍抛 apply 根因", () => {
  it("回卷错误不吞根因", async () => {
    const ctx = createContext();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const plugins: Plugin[] = [
        {
          name: "bad-unwind",
          apply: () => () => {
            throw new Error("unwind boom");
          },
        },
        {
          name: "bad-apply",
          apply: () => {
            throw new Error("apply boom");
          },
        },
      ];
      await expect(loadPlugins(ctx, plugins)).rejects.toThrow("apply boom");
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("审查 #10：僵尸 next 围栏（macrotask 形态）", () => {
  it("中间件返回后 setTimeout 触发的 next → throw，不影响 dispatch 结果", async () => {
    const ctx = createContext();
    const token = defineWaterfall<number, number>("wf-zombie");
    ctx.on(token, async (input, next) => {
      const result = next(input);
      fireZombieNext(next, input);
      return result;
    });
    const out = await ctx.dispatch(token, 1, async (i) => i * 10);
    expect(out).toBe(10);
    await sleep(5);
    expect(zombieNextError?.message).toContain("after middleware returned");
  });
});

describe("审查 #11：dispatch 的祖先链 live 检查（半拆态窗口）", () => {
  it("父层回卷进行中，子层 dispatch 拒绝", async () => {
    const ctx = createContext();
    const child = ctx.scope({ agentId: "child" });
    const token = defineSerial<{ v: number }>("ser-half");
    let caught: Error | undefined;
    let releaseParent: (() => void) | undefined;
    ctx.effect(
      () =>
        new Promise<void>((resolve) => {
          releaseParent = resolve;
        }),
    );
    const disposing = ctx.dispose();
    await sleep(0);
    try {
      await child.dispatch(token, { v: 1 });
    } catch (error) {
      caught = error as Error;
    }
    releaseParent?.();
    await disposing;
    expect(caught?.message).toContain("rejected while a scope chain layer is disposing");
  });
});

describe("审查 #12：emit 异步监听器 rejection 进 sink（不崩进程）", () => {
  it("async 监听器 reject → sink 收到、后续监听器照常", async () => {
    const sink = vi.fn();
    const ctx = createContext({ onListenerError: sink });
    const token = defineEvent<{ v: number }>("evt-async");
    const later = vi.fn();
    ctx.on(token, async () => {
      throw new Error("async boom");
    });
    ctx.on(token, later);
    expect(() => ctx.emit(token, { v: 1 })).not.toThrow();
    await sleep(0);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1);
  });
});

describe("审查 #13：分发中退订的快照语义（本次仍执行、下次不执行）", () => {
  it("emit 迭代中退订后续监听者", () => {
    const ctx = createContext();
    const token = defineEvent<{ v: number }>("evt-midstop");
    const heard: number[] = [];
    const stopSecond = ctx.on(token, ({ v }) => heard.push(v * 10));
    ctx.on(token, ({ v }) => heard.push(v * 100));
    ctx.on(token, () => stopSecond());
    ctx.emit(token, { v: 1 });
    expect(heard).toEqual([10, 100]);
    heard.length = 0;
    ctx.emit(token, { v: 2 });
    expect(heard).toEqual([200]);
  });

  it("waterfall 迭代中退订后续中间件（快照语义）", async () => {
    const ctx = createContext();
    const token = defineWaterfall<number, number>("wf-midstop");
    const stopSecond = ctx.on(token, async (i, next) => next(i + 1));
    ctx.on(token, async (i, next) => {
      stopSecond();
      return next(i + 100);
    });
    const out = await ctx.dispatch(token, 1, async (i) => i);
    expect(out).toBe(102);
    const again = await ctx.dispatch(token, 1, async (i) => i);
    expect(again).toBe(101);
  });
});

describe("审查 #3 补充：sibling 的 service/provided 隔离", () => {
  it("兄弟层互相听不见对方 provide", () => {
    const aHeard: string[] = [];
    const ctx = createContext();
    const a = ctx.scope({ agentId: "a" });
    const b = ctx.scope({ agentId: "b" });
    a.on(serviceProvided, ({ service }) => aHeard.push(service));
    const token = defineService<{ n: number }>("svc-b");
    b.provide(token, { n: 0 });
    expect(aHeard).toEqual([]);
  });
});
