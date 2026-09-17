// 运行期插件生命周期：追加装配 / 分发中注册（快照语义的注册面）/ dispose 与在飞 dispatch 交错。
// 对应对话审计的三项口头主张——没有能让它失败的用例之前，评估不算数。
import { describe, expect, it } from "vitest";
import { createContext } from "../create-context.ts";
import { loadPlugins } from "../load-plugins.ts";
import { defineEvent, defineService, defineWaterfall } from "../tokens.ts";
import type { Plugin } from "../types.ts";

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
