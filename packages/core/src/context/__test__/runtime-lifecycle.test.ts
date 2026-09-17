// 运行期插件生命周期：追加装配 / 分发中注册（快照语义的注册面）/ dispose 与在飞 dispatch 交错。
// 对应对话审计的三项口头主张——没有能让它失败的用例之前，评估不算数。
import { describe, expect, it, vi } from "vitest";
import { createContext } from "../create-context.ts";
import { loadPlugins } from "../load-plugins.ts";
import { defineEvent, defineService, defineWaterfall } from "../tokens.ts";
import type { Plugin } from "../types.ts";
import { pluginUnloaded } from "../vocab.ts";

describe("运行期追加装配（D18 注册面开放）", () => {
  it("二次 loadPlugins：新服务即时可用、新监听者只听见后续事件、两批都随层回卷", async () => {
    const ctx = createContext();
    const ping = defineEvent<{ v: number }>("ping");
    const baseHeard: number[] = [];
    const lateHeard: number[] = [];

    await loadPlugins(ctx, [
      {
        name: "base",
        apply: (c) => {
          c.on(ping, ({ v }) => baseHeard.push(v));
        },
      },
    ]);
    ctx.emit(ping, { v: 1 }); // 装配后先使用一轮

    const svc = defineService<{ tag: string }>("runtime-svc");
    await loadPlugins(ctx, [
      {
        name: "late",
        apply: (c) => {
          c.provide(svc, { tag: "late" });
          c.on(ping, ({ v }) => lateHeard.push(v));
        },
      },
    ]);

    expect(ctx.use(svc).tag).toBe("late"); // 新服务即时可用
    ctx.emit(ping, { v: 2 });
    expect(baseHeard).toEqual([1, 2]);
    expect(lateHeard).toEqual([2]); // 晚到者只听见注册后的事件

    await ctx.dispose();
    ctx.emit(ping, { v: 3 }); // emit 在 dispose 后允许
    expect(baseHeard).toEqual([1, 2]);
    expect(lateHeard).toEqual([2]); // 两批注册都随层回卷
  });

  it("追加装配的插件卸载走层粒度：scope dispose 整组消失", async () => {
    const ctx = createContext();
    const layer = ctx.scope({ agentId: "extra" });
    const svc = defineService<{ n: number }>("layer-svc");
    const plugin: Plugin = {
      name: "p",
      apply: (c) => {
        c.provide(svc, { n: 1 });
      },
    };
    await loadPlugins(layer, [plugin]);
    expect(layer.use(svc).n).toBe(1);
    await layer.dispose();
    expect(ctx.tryUse(svc)).toBeUndefined(); // 整组随层消失，root 不受影响
  });
});

describe("分发中注册（快照语义的注册面，与退订面 #13 对偶）", () => {
  it("emit 迭代中注册新监听者：本次不执行、下次执行", () => {
    const ctx = createContext();
    const token = defineEvent<{ v: number }>("evt-midreg");
    const order: number[] = [];
    ctx.on(token, ({ v }) => {
      order.push(v);
      if (v === 1) {
        ctx.on(token, ({ v: again }) => order.push(again * 100)); // 迭代中注册
      }
    });
    ctx.emit(token, { v: 1 });
    expect(order).toEqual([1]); // 本次快照不含新监听者
    ctx.emit(token, { v: 2 });
    expect(order).toEqual([1, 2, 200]); // 下次生效
  });

  it("waterfall 派发中注册中间件：本次快照不含、下次含", async () => {
    const ctx = createContext();
    const token = defineWaterfall<number, number>("wf-midreg");
    ctx.on(token, async (input, next) => {
      ctx.on(token, async (j, deeper) => deeper(j + 100)); // 派发中注册
      return next(input);
    });
    const first = await ctx.dispatch(token, 1, async (i) => i);
    expect(first).toBe(1); // 本次快照只有原中间件
    const second = await ctx.dispatch(token, 1, async (i) => i);
    expect(second).toBe(101); // 下次两层洋葱
  });
});

describe("dispose 与在飞 dispatch 交错（已知边界的语义锁定）", () => {
  it("在飞中间件依赖已回卷服务 → dispatch reject（失败暴露，不静默）", async () => {
    const ctx = createContext();
    const svc = defineService<{ n: number }>("svc-inflight");
    ctx.provide(svc, { n: 1 });
    const token = defineWaterfall<number, number>("wf-inflight");
    let release: ((value: number) => void) | undefined;
    ctx.on(token, async (input, next) => {
      await new Promise<number>((resolve) => {
        release = resolve; // 挂起：让 dispose 在中间件执行中途发生
      });
      void ctx.use(svc).n; // 服务已随回卷消失 → throw
      return next(input);
    });

    const dispatching = ctx.dispatch(token, 1, async (i) => i);
    await new Promise((r) => setTimeout(r, 0)); // 中间件进入挂起
    const disposing = ctx.dispose(); // 回卷（监听器与服务注销），不等在飞 dispatch
    await new Promise((r) => setTimeout(r, 0));
    release?.(0); // 放行中间件

    await expect(dispatching).rejects.toThrow(/not provided/); // 失败暴露
    await expect(disposing).resolves.toBeUndefined(); // dispose 自身完成
  });
});

describe("单插件粒度卸载（loadPlugins 返回卸载句柄）", () => {
  it("卸 A 留 B：A 的注册消失、B 完好；句柄幂等；apply-disposer 恰好一次、层回卷不双跑", async () => {
    const ctx = createContext();
    const ping = defineEvent<{ v: number }>("ping-unload");
    const svcA = defineService<{ tag: string }>("svc-a");
    const svcB = defineService<{ tag: string }>("svc-b");
    const aHeard: number[] = [];
    const bHeard: number[] = [];
    const aCleanup = vi.fn();
    const bCleanup = vi.fn();

    const [unloadA, unloadB] = await loadPlugins(ctx, [
      {
        name: "a",
        apply: (c) => {
          c.provide(svcA, { tag: "a" });
          c.on(ping, ({ v }) => aHeard.push(v));
          return aCleanup;
        },
      },
      {
        name: "b",
        apply: (c) => {
          c.provide(svcB, { tag: "b" });
          c.on(ping, ({ v }) => bHeard.push(v));
          return bCleanup;
        },
      },
    ]);
    if (unloadA === undefined || unloadB === undefined) throw new Error("unloaders missing");
    expect(ctx.use(svcA).tag).toBe("a");
    expect(ctx.use(svcB).tag).toBe("b");

    await unloadA();
    await unloadA(); // 幂等
    expect(ctx.tryUse(svcA)).toBeUndefined(); // A 的服务消失
    expect(ctx.use(svcB).tag).toBe("b"); // B 完好
    ctx.emit(ping, { v: 1 });
    expect(aHeard).toEqual([]);
    expect(bHeard).toEqual([1]);
    expect(aCleanup).toHaveBeenCalledTimes(1); // apply-disposer 恰好一次

    await ctx.dispose(); // 层回卷兜底：不双跑
    expect(aCleanup).toHaveBeenCalledTimes(1);
    expect(bCleanup).toHaveBeenCalledTimes(1); // 未手动卸载的 B 由层回卷收
    expect(unloadB).toBeTypeOf("function");
  });

  it("运行期追加装配同样获得卸载句柄：卸载后回到追加前状态", async () => {
    const ctx = createContext();
    const ping = defineEvent<{ v: number }>("ping-late-unload");
    const heard: number[] = [];
    ctx.on(ping, ({ v }) => heard.push(v));
    const svc = defineService<{ n: number }>("late-svc");
    const [unloadLate] = await loadPlugins(ctx, [
      {
        name: "late",
        apply: (c) => {
          c.provide(svc, { n: 1 });
        },
      },
    ]);
    if (unloadLate === undefined) throw new Error("unloader missing");
    expect(ctx.tryUse(svc)).toEqual({ n: 1 });
    await unloadLate();
    expect(ctx.tryUse(svc)).toBeUndefined(); // 回到追加前
    ctx.emit(ping, { v: 1 });
    expect(heard).toEqual([1]); // 原有注册不受影响
  });
});

describe("apply 期 wrapper 委托面（捕获包装不改变 Context 语义）", () => {
  it("经 wrapper 的 use/tryUse/emit/dispatch/onChain 与直连 ctx 行为一致", async () => {
    const ctx = createContext();
    const svc = defineService<{ n: number }>("w-svc");
    const tick = defineEvent<{ v: number }>("w-tick");
    const wf = defineWaterfall<number, number>("w-wf");
    const seen: number[] = [];
    ctx.on(tick, ({ v }) => seen.push(v));

    let chainResult = -1;
    const chainSvc = defineService<{ decide: { dispatch(i: number): Promise<number> } }>("w-chain");
    await loadPlugins(ctx, [
      {
        name: "base",
        apply: (c) => {
          c.provide(svc, { n: 5 });
          const decide = c.createChain<number, number>(async (i) => i * 2);
          c.onChain(decide, async (i, next) => next(i + 1));
          c.provide(chainSvc, { decide });
        },
      },
      {
        name: "user",
        inject: ["base"],
        apply: async (c) => {
          const n = c.use(svc).n; // wrapper.use
          if (c.tryUse(svc)?.n !== n) throw new Error("tryUse mismatch"); // wrapper.tryUse
          c.emit(tick, { v: n }); // wrapper.emit
          chainResult = await c.dispatch(wf, n, async (i) => i + 1); // wrapper.dispatch
        },
      },
    ]);
    expect(seen).toEqual([5]);
    expect(chainResult).toBe(6);
    // 匿名链经 wrapper 创建/注册：语义与直连一致（final 绑定 + 消费方层归属）
    const decide = ctx.use(chainSvc).decide;
    expect(await decide.dispatch(1)).toBe(4); // (1+1)*2
  });
});

describe("按名卸载与卸载容错", () => {
  it("宿主组合按名卸载：name→handle 映射（内核不立 name-keyed 注册表的形态）", async () => {
    const ctx = createContext();
    const ping = defineEvent<{ v: number }>("ping-byname");
    const svcOtel = defineService<{ on: boolean }>("svc-otel");
    const otelHeard: number[] = [];
    const seen: string[] = [];
    ctx.on(pluginUnloaded, ({ plugin }) => seen.push(plugin));

    const plugins: Plugin[] = [
      { name: "otel", apply: (c) => { c.provide(svcOtel, { on: true }); c.on(ping, ({v}) => otelHeard.push(v)); } },
      { name: "other", apply: () => {} },
    ];
    const unloaders = await loadPlugins(ctx, plugins);
    const byName = new Map(plugins.map((plugin, i) => [plugin.name, unloaders[i]]));

    await byName.get("otel")?.();
    expect(ctx.tryUse(svcOtel)).toBeUndefined();
    ctx.emit(ping, { v: 1 });
    expect(otelHeard).toEqual([]);
    expect(seen).toEqual(["otel"]); // 卸载广播按名
  });

  it("unload 容错：单个 disposer 抛错——其余仍回卷、聚合上抛、重试 no-op、事件仍广播", async () => {
    const ctx = createContext();
    const svc = defineService<{ n: number }>("svc-fail-unload");
    const ranAfterFailure = vi.fn();
    const seen: string[] = [];
    ctx.on(pluginUnloaded, ({ plugin }) => seen.push(plugin));

    const unloaders = await loadPlugins(ctx, [
      {
        name: "fragile",
        apply: (c) => {
          c.provide(svc, { n: 1 });
          c.effect(() => { ranAfterFailure(); }); // 最先注册 → 逆序最后跑
          c.effect(() => { throw new Error("cleanup boom"); });
        },
      },
    ]);
    const unload = unloaders[0];
    if (unload === undefined) throw new Error("unloader missing");

    await expect(unload()).rejects.toThrow("cleanup boom");
    expect(ranAfterFailure).toHaveBeenCalledTimes(1); // 抛错后其余仍回卷（逆序：最后才到它）
    expect(ctx.tryUse(svc)).toBeUndefined(); // provide 也已注销
    expect(seen).toEqual(["fragile"]); // 部分失败仍广播卸载完成
    await expect(unload()).resolves.toBeUndefined(); // 重试 no-op（半卸载不会发生——已全部尝试）
  });

  it("loaded ↔ unloaded 成对（C12）：装卸各恰好一次、按名", async () => {
    const ctx = createContext();
    const trace: string[] = [];
    const unloaders = await loadPlugins(ctx, [{ name: "p", apply: () => {} }]);
    // loadPlugins 内部广播 plugin/loaded；此处订阅晚于装载，只验证 unloaded 侧
    ctx.on(pluginUnloaded, ({ plugin }) => trace.push(`unloaded:${plugin}`));
    const unload = unloaders[0];
    if (unload === undefined) throw new Error("unloader missing");
    await unload();
    await unload(); // 幂等：只广播一次
    expect(trace).toEqual(["unloaded:p"]);
  });
});
