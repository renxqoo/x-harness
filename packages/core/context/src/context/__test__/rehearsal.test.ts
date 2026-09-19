// §9 用法预演的验收剧本 + §10 风险 3（preset-on-scope 等价性）——
// 实现期逐段对照，跑不通即为实现或规格缺陷（docs/CONTEXT.md §9 引言）。
import { describe, expect, it } from "vitest";
import { createContext } from "../create-context.ts";
import { loadPlugins } from "../load-plugins.ts";
import { defineEvent, defineService, defineWaterfall } from "../tokens.ts";
import type { Chain, Plugin } from "../types.ts";
import { pluginEvent } from "../vocab.ts";

describe("§9 用法预演", () => {
  it("9.1 写插件：provide + on + disposer（配置工厂闭包，C8）", async () => {
    const ctx = createContext();
    const flushed: string[] = [];
    const notifierService = defineService<{ push(msg: string): void }>("notifier");
    const tick = defineEvent<{ v: number }>("tick");

    function createNotifier(webhook: string): Plugin {
      return {
        name: "notify",
        inject: [],
        apply(c) {
          const queue: string[] = [];
          c.provide(notifierService, { push: (m) => queue.push(m) });
          c.on(tick, ({ v }) => queue.push(`tick-${v}`));
          return () => {
            flushed.push(`${webhook}:${queue.join(",")}`);
          };
        },
      };
    }

    await loadPlugins(ctx, [createNotifier("hook-1")]);
    ctx.use(notifierService).push("hello");
    ctx.emit(tick, { v: 1 });
    await ctx.dispose();
    expect(flushed).toEqual(["hook-1:hello,tick-1"]);
  });

  it("9.2 宿主在 root 订阅即看见全部后代（chain-up）", () => {
    const ctx = createContext();
    const child = ctx.scope({ agentId: "child" });
    const grandchild = child.scope({ agentId: "grandchild" });
    const events: string[] = [];
    const tick = defineEvent<{ v: number }>("tick");
    const envelopes: string[] = [];
    ctx.on(tick, ({ v }) => events.push(`tick-${v}`));
    ctx.on(pluginEvent, ({ plugin, kind }) => envelopes.push(`${plugin}/${kind}`));
    grandchild.emit(tick, { v: 1 });
    grandchild.emit(pluginEvent, { plugin: "p", kind: "k", data: null, ts: 1 });
    expect(events).toEqual(["tick-1"]);
    expect(envelopes).toEqual(["p/k"]);
  });

  it("9.3 重试中间件：串行重调 next = 真实重发（I2）", async () => {
    const ctx = createContext();
    const llmStream = defineWaterfall<{ prompt: string }, string>("llm/stream");
    let attempts = 0;
    ctx.on(llmStream, async (input, next) => {
      for (let attempt = 1; ; attempt++) {
        const outcome = await next(input);
        if (outcome === "transient-error" && attempt < 3) continue; // 串行重调
        return outcome;
      }
    });
    const out = await ctx.dispatch(
      llmStream,
      { prompt: "hi" },
      async () => {
        attempts += 1;
        return attempts < 2 ? "transient-error" : "ok";
      },
    );
    expect(out).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("9.4 spawn 子代理：scope + nearest-first 遮蔽（restricted 视图）", async () => {
    const ctx = createContext();
    const toolsService = defineService<{ list(): string[] }>("tools");
    ctx.provide(toolsService, { list: () => ["search", "bash", "fs"] });
    const parentTools = ctx.use(toolsService);
    const child = ctx.scope({ agentId: "child" });
    child.provide(toolsService, {
      list: () => parentTools.list().filter((t) => t === "search"),
    });
    expect(child.use(toolsService).list()).toEqual(["search"]);
    expect(ctx.use(toolsService).list()).toEqual(["search", "bash", "fs"]);
    await child.dispose();
    expect(ctx.use(toolsService).list()).toEqual(["search", "bash", "fs"]); // 父完好
  });

  it("9.5 匿名链跨插件：服务共享 + onChain 层归属消费方", async () => {
    const ctx = createContext();
    interface AgentsService {
      spawnDecide: Chain<number, { allow: boolean }>;
    }
    const agentsService = defineService<AgentsService>("agents");

    // owner 插件：暴露 spawn 决策点
    const ownerPlugin: Plugin = {
      name: "agents",
      apply(c) {
        const spawnDecide = c.createChain<number, { allow: boolean }>(async (spec) => ({
          allow: spec < 100,
        }));
        c.provide(agentsService, { spawnDecide });
      },
    };
    // 消费插件：经自己的 ctx 注册（层归属消费方）
    const consumerPlugin: Plugin = {
      name: "policy",
      inject: ["agents"],
      apply(c) {
        c.onChain(c.use(agentsService).spawnDecide, async (spec, next) => {
          const verdict = await next(spec);
          return spec === 42 ? { allow: true } : verdict; // 42 永远放行
        });
      },
    };

    await loadPlugins(ctx, [ownerPlugin, consumerPlugin]);
    const decide = ctx.use(agentsService).spawnDecide;
    expect((await decide.dispatch(42)).allow).toBe(true);
    expect((await decide.dispatch(1000)).allow).toBe(false);
  });

  it("9.6 回卷：子层逆序，root 收编子层", async () => {
    const ctx = createContext();
    const trace: string[] = [];
    const child = ctx.scope({ agentId: "child" });
    child.effect(() => {
      trace.push("child-a");
    });
    child.effect(() => {
      trace.push("child-b");
    });
    ctx.effect(() => {
      trace.push("root");
    });
    await child.dispose();
    expect(trace).toEqual(["child-b", "child-a"]);
    await ctx.dispose();
    expect(trace).toEqual(["child-b", "child-a", "root"]);
  });
});

describe("§10 风险 3：preset-on-scope 等价性（M1 必测验收项）", () => {
  it("双 sibling scope 各自 loadPlugins 同一插件：服务互不串、root 无此服务", async () => {
    const ctx = createContext();
    const counterService = defineService<{ n: number }>("counter");
    // 同一插件工厂两次实例化（preset 场景：每 agent 一份）
    function createCounterPlugin(): Plugin {
      return {
        name: "counter",
        apply(c) {
          c.provide(counterService, { n: 0 }); // 每层各一份
        },
      };
    }

    const a = ctx.scope({ agentId: "agent-a" });
    const b = ctx.scope({ agentId: "agent-b" });
    await loadPlugins(a, [createCounterPlugin()]);
    await loadPlugins(b, [createCounterPlugin()]);

    a.use(counterService).n = 7;
    expect(b.use(counterService).n).toBe(0); // 互不串
    expect(a.use(counterService)).not.toBe(b.use(counterService));
    expect(ctx.tryUse(counterService)).toBeUndefined(); // root 无——没变成进程全局
  });

  it("双 sibling scope 的监听互不可见（事件面同口径）", async () => {
    const ctx = createContext();
    const tick = defineEvent<{ v: number }>("tick");
    const aHeard: number[] = [];
    const bHeard: number[] = [];
    const a = ctx.scope({ agentId: "agent-a" });
    const b = ctx.scope({ agentId: "agent-b" });
    const listener: Plugin = {
      name: "listener",
      apply(c) {
        c.on(tick, ({ v }) => aHeard.push(v)); // a 与 b 各自装配
      },
    };
    await loadPlugins(a, [listener]);
    await loadPlugins(b, [
      {
        ...listener,
        apply(c) {
          c.on(tick, ({ v }) => bHeard.push(v));
        },
      },
    ]);
    a.emit(tick, { v: 1 });
    expect(aHeard).toEqual([1]);
    expect(bHeard).toEqual([]);
  });

  it("一 sibling dispose 不影响另一个的插件服务", async () => {
    const ctx = createContext();
    const counterService = defineService<{ n: number }>("counter");
    const counterPlugin: Plugin = {
      name: "counter",
      apply(c) {
        c.provide(counterService, { n: 0 });
      },
    };
    const a = ctx.scope({ agentId: "a" });
    const b = ctx.scope({ agentId: "b" });
    await loadPlugins(a, [counterPlugin]);
    await loadPlugins(b, [counterPlugin]);
    await a.dispose();
    expect(b.use(counterService).n).toBe(0);
    expect(() => a.use(counterService)).toThrow(/not provided/);
  });
});

describe("回卷错误传播", () => {
  it("子层回卷抛错向上暴露给 dispose 调用方", async () => {
    const ctx = createContext();
    const child = ctx.scope({ agentId: "child" });
    child.effect(() => {
      throw new Error("child unwind boom");
    });
    await expect(ctx.dispose()).rejects.toThrow("child unwind boom");
  });
});
