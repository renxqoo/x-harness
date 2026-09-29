import { describe, expect, it, vi } from "vitest";
import { createContext } from "../create-context.ts";
import { loadPlugins } from "../load-plugins.ts";
import {
  defineEvent,
  defineParallel,
  defineService,
  defineWaterfall,
} from "../tokens.ts";
import type { Plugin } from "../types.ts";

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const later = <T>(value: T, ms: number): Promise<T> =>
  new Promise<T>((resolve) => {
    setTimeout(() => resolve(value), ms);
  });

describe("parallel 派发（emit 的异步屏障版）", () => {
  it("并发执行全部并等待 settle；无错 resolve", async () => {
    const ctx = createContext();
    const token = defineParallel<{ v: number }>("par-ok");
    const started: number[] = [];
    const finished: number[] = [];
    ctx.on(token, async ({ v }) => {
      started.push(v);
      await sleep(10);
      finished.push(v);
    });
    ctx.on(token, async ({ v }) => {
      started.push(v * 10);
      await sleep(5);
      finished.push(v * 10);
    });
    await ctx.dispatch(token, { v: 1 });
    expect(started).toEqual([1, 10]);
    expect(finished).toEqual([10, 1]);
  });

  it("并发是真的：慢监听器不阻塞快监听器完成", async () => {
    const ctx = createContext();
    const token = defineParallel<{ v: number }>("par-concurrent");
    const events: string[] = [];
    ctx.on(token, async () => {
      await sleep(20);
      events.push("slow-done");
    });
    ctx.on(token, async () => {
      await sleep(1);
      events.push("fast-done");
    });
    await ctx.dispatch(token, { v: 1 });
    expect(events).toEqual(["fast-done", "slow-done"]);
  });

  it("单错抛原错、多错 AggregateError", async () => {
    const ctx = createContext();
    const token = defineParallel<{ v: number }>("par-err");
    ctx.on(token, async () => {
      throw new Error("boom-a");
    });
    ctx.on(token, async () => undefined);
    await expect(ctx.dispatch(token, { v: 1 })).rejects.toThrow("boom-a");

    const ctx2 = createContext();
    const token2 = defineParallel<{ v: number }>("par-err-multi");
    ctx2.on(token2, async () => {
      throw new Error("a");
    });
    ctx2.on(token2, async () => {
      throw new Error("b");
    });
    const caught = await ctx2.dispatch(token2, { v: 1 }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(2);
  });

  it("payload 深冻结；scope 链可见性与他模式同律", async () => {
    const ctx = createContext();
    const child = ctx.scope({ agentId: "c" });
    const token = defineParallel<{ nested: { x: number } }>("par-freeze");
    let frozen = false;
    child.on(token, (payload) => {
      frozen = Object.isFrozen(payload.nested);
    });
    await ctx.dispatch(token, { nested: { x: 1 } });
    expect(frozen).toBe(false);
    await child.dispatch(token, { nested: { x: 1 } });
    expect(frozen).toBe(true);
  });
});

describe("waitFor（延迟 use——DI 停靠的内核原语）", () => {
  it("可见即解析", async () => {
    const ctx = createContext();
    const token = defineService<{ n: number }>("svc-now");
    ctx.provide(token, { n: 1 });
    await expect(ctx.waitFor(token)).resolves.toEqual({ n: 1 });
  });

  it("停靠等待：服务后到时解析（拿到的是当下最近实现）", async () => {
    const ctx = createContext();
    const token = defineService<{ n: number }>("svc-late");
    const waiting = ctx.waitFor(token);
    ctx.provide(token, { n: 1 });
    await expect(waiting).resolves.toEqual({ n: 1 });
  });

  it("子层停靠等待 root 提供（可见性=use 语义，非事件方向）", async () => {
    const ctx = createContext();
    const child = ctx.scope({ agentId: "c" });
    const token = defineService<{ n: number }>("svc-root-late");
    const waiting = child.waitFor(token);
    ctx.provide(token, { n: 2 });
    await expect(waiting).resolves.toEqual({ n: 2 });
  });

  it("方向性：等待者看不见的提供不解析；可见时立即拿到最近值", async () => {
    const ctx = createContext();
    const token = defineService<{ n: number }>("svc-dir");
    const waiting = ctx.waitFor(token);
    const child = ctx.scope({ agentId: "c" });
    child.provide(token, { n: 9 });
    const raced = await Promise.race([
      waiting.then(() => "resolved" as const),
      later("parked", 10),
    ]);
    expect(raced).toBe("parked");
    ctx.provide(token, { n: 1 });
    await expect(waiting).resolves.toEqual({ n: 1 });
  });

  it("等待层 dispose：停靠中的 waiter reject", async () => {
    const ctx = createContext();
    const child = ctx.scope({ agentId: "c" });
    const token = defineService<{ n: number }>("svc-never");
    const waiting = child.waitFor(token);
    await child.dispose();
    await expect(waiting).rejects.toThrow(/never arrived/);
  });

  it("插件 apply 经 waitFor 停靠：依赖后到自动接线（自动停靠的组合形态）", async () => {
    const ctx = createContext();
    const dbToken = defineService<{ query(): string }>("db");
    const seen: string[] = [];
    const consumer: Plugin = {
      name: "consumer",
      apply: async (c) => {
        const db = await c.waitFor(dbToken);
        seen.push(db.query());
      },
    };
    const loading = loadPlugins(ctx, [consumer]);
    await sleep(2);
    await loadPlugins(ctx, [
      {
        name: "db",
        apply: (c) => {
          c.provide(dbToken, { query: () => "rows" });
        },
      },
    ]);
    await loading;
    expect(seen).toEqual(["rows"]);
  });
});

describe("prepend 次序旋钮", () => {
  it("emit：段头插入——后注册的 prepend 监听器先执行", () => {
    const ctx = createContext();
    const token = defineEvent<{ v: number }>("evt-prepend");
    const order: string[] = [];
    ctx.on(token, () => order.push("first-registered"));
    ctx.on(token, () => order.push("prepended"), { prepend: true });
    ctx.emit(token, { v: 1 });
    expect(order).toEqual(["prepended", "first-registered"]);
  });

  it("层序仍优先：child 的 prepend 不越过 root", () => {
    const ctx = createContext();
    const child = ctx.scope({ agentId: "c" });
    const token = defineEvent<{ v: number }>("evt-prepend-layer");
    const order: string[] = [];
    child.on(token, () => order.push("child-prepend"), { prepend: true });
    ctx.on(token, () => order.push("root-normal"));
    child.emit(token, { v: 1 });
    expect(order).toEqual(["root-normal", "child-prepend"]);
  });

  it("waterfall：prepend 中间件成为本层最外层", async () => {
    const ctx = createContext();
    const token = defineWaterfall<number, number>("wf-prepend");
    ctx.on(token, async (i, next) => next(i + 1));
    ctx.on(token, async (i, next) => next(i + 10), { prepend: true });
    const out = await ctx.dispatch(token, 1, async (i) => i);
    expect(out).toBe(12);
  });
});

describe("装配 join（dispose 自动等在飞装配 settle）", () => {
  it("dispose 与在飞装配交错：dispose 完成前装配必 settle；冲突 fail-fast 不静默", async () => {
    const ctx = createContext();
    const svc = defineService<{ n: number }>("svc-join");
    let gate: (() => void) | undefined;
    const gated = new Promise<void>((r) => {
      gate = r;
    });
    const loading = loadPlugins(ctx, [
      {
        name: "slow",
        apply: async (c) => {
          c.provide(svc, { n: 1 });
          await gated;
        },
      },
    ]);
    await sleep(2);
    const disposing = ctx.dispose();
    await sleep(2);
    const observed = await Promise.race([
      disposing.then(() => "disposed" as const),
      later("pending", 5),
    ]);
    expect(observed).toBe("pending");
    gate?.();
    await expect(loading).rejects.toThrow();
    await expect(disposing).resolves.toBeUndefined();
    expect(ctx.tryUse(svc)).toBeUndefined();
  });

  it("在飞装配在 disposing 层上的后续注册 fail-fast，但 dispose 不挂死", async () => {
    const ctx = createContext();
    const svc = defineService<{ n: number }>("svc-race2");
    let gate: (() => void) | undefined;
    const gated = new Promise<void>((r) => {
      gate = r;
    });
    const loading = loadPlugins(ctx, [
      {
        name: "a",
        apply: async (c) => {
          c.provide(svc, { n: 1 });
          await gated;
        },
      },
      {
        name: "b",
        apply: (c) => {
          void c.provide(defineService<{ x: number }>("svc-b"), { x: 1 });
        },
      },
    ]);
    await sleep(2);
    const disposing = ctx.dispose();
    await sleep(2);
    gate?.();
    await expect(loading).rejects.toThrow(/rejected after dispose/);
    await expect(disposing).resolves.toBeUndefined();
  });
});

describe("生产热替换形态（unload v1 + load v2，状态经宿主服务迁移）", () => {
  it("换版本：旧行为消失、新行为生效、状态保真", async () => {
    const ctx = createContext();
    const tick = defineEvent<{ v: number }>("tick-swap");
    const state = defineService<{ count: number }>("swap-state");
    ctx.provide(state, { count: 0 });

    const [unloadV1] = await loadPlugins(ctx, [
      {
        name: "counter",
        apply: (c) => {
          c.on(tick, () => {
            c.use(state).count += 1;
          });
        },
      },
    ]);
    if (unloadV1 === undefined) throw new Error("unloader missing");
    ctx.emit(tick, { v: 1 });
    ctx.emit(tick, { v: 1 });
    expect(ctx.use(state).count).toBe(2);

    await unloadV1();
    await loadPlugins(ctx, [
      {
        name: "counter",
        apply: (c) => {
          c.on(tick, () => {
            c.use(state).count += 10;
          });
        },
      },
    ]);
    ctx.emit(tick, { v: 1 });
    expect(ctx.use(state).count).toBe(12);
    const spy = vi.fn();
    ctx.on(tick, () => spy());
    ctx.emit(tick, { v: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ctx.use(state).count).toBe(22);
  });
});
