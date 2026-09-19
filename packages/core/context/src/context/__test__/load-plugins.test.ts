import { describe, expect, it, vi } from "vitest";
import { createContext } from "../create-context.ts";
import { loadPlugins } from "../load-plugins.ts";
import type { Plugin } from "../types.ts";
import { pluginError, pluginLoaded } from "../vocab.ts";

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const noop = (): void => {};

describe("插件加载器（§5）", () => {
  it("inject topo：依赖者后跑", async () => {
    const ctx = createContext();
    const order: string[] = [];
    const plugins: Plugin[] = [
      { name: "app", inject: ["db", "cache"], apply: () => { order.push("app"); } },
      { name: "cache", inject: ["db"], apply: () => { order.push("cache"); } },
      { name: "db", apply: () => { order.push("db"); } },
    ];
    await loadPlugins(ctx, plugins);
    expect(order).toEqual(["db", "cache", "app"]);
  });

  it("循环依赖 → 预扫描 throw（未跑任何 apply）", async () => {
    const ctx = createContext();
    const ran: string[] = [];
    const plugins: Plugin[] = [
      { name: "a", inject: ["b"], apply: () => { ran.push("a"); } },
      { name: "b", inject: ["a"], apply: () => { ran.push("b"); } },
    ];
    await expect(loadPlugins(ctx, plugins)).rejects.toThrow(/cyclic/);
    expect(ran).toEqual([]);
  });

  it("重名插件 → throw", async () => {
    const ctx = createContext();
    const plugins: Plugin[] = [
      { name: "dup", apply: () => {} },
      { name: "dup", apply: () => {} },
    ];
    await expect(loadPlugins(ctx, plugins)).rejects.toThrow(/duplicate plugin name/);
  });

  it("inject 引用不存在的插件 → throw（IMPL 裁决 5）", async () => {
    const ctx = createContext();
    const plugins: Plugin[] = [{ name: "a", inject: ["ghost"], apply: () => {} }];
    await expect(loadPlugins(ctx, plugins)).rejects.toThrow(/unknown plugin "ghost"/);
  });

  it("有 name 无 apply 函数的对象 → 装配期 throw（非 dispose 期深处）", async () => {
    const ctx = createContext();
    await expect(loadPlugins(ctx, [{ name: "hollow" } as never])).rejects.toThrow(/plugin "hollow" has no apply function/);
  });

  it("apply 返回非函数（如误返回插件对象/配置）→ 装配期 throw，不进 unwind 链", async () => {
    const ctx = createContext();
    const impostor = { str: "not a disposer" };
    await expect(
      loadPlugins(ctx, [{ name: "bad-return", apply: () => impostor } as never]),
    ).rejects.toThrow(/plugin "bad-return" apply must return a disposer function or void — got object/);
    await ctx.dispose(); // 崩在装配期而非 dispose——干净
  });

  it("工厂函数冒充插件（漏调用）→ 装配期 fail-fast 并点名调用法", async () => {
    const ctx = createContext();
    // 形状复刻：命名工厂函数自带 name/Function.prototype.apply，结构上满足 Plugin——
    // 症状（修复前）：apply 变无参调用工厂，副作用不发生 + 返回对象进 unwind 链崩 dispose
    const createGhost = (): Plugin => ({ name: "ghost", apply: () => {} });
    await expect(loadPlugins(ctx, [createGhost as never])).rejects.toThrow(
      /plugin is a factory function, not a plugin — call it: createGhost\(\)/,
    );
  });

  it("apply 返回 disposer 自动入账，dispose 时回卷", async () => {
    const ctx = createContext();
    const unwound = vi.fn();
    await loadPlugins(ctx, [{ name: "p", apply: () => unwound }]);
    expect(unwound).not.toHaveBeenCalled();
    await ctx.dispose();
    expect(unwound).toHaveBeenCalledTimes(1);
  });

  it("逐个广播 plugin/loaded", async () => {
    const ctx = createContext();
    const loaded: string[] = [];
    ctx.on(pluginLoaded, ({ plugin }) => loaded.push(plugin));
    await loadPlugins(ctx, [
      { name: "a", apply: () => {} },
      { name: "b", apply: () => {} },
    ]);
    expect(loaded).toEqual(["a", "b"]);
  });

  it("apply 抛错 → plugin/error 广播 + reject + 整体回卷（IMPL 裁决 2）", async () => {
    const ctx = createContext();
    const errors: string[] = [];
    const unwound = vi.fn();
    ctx.on(pluginError, ({ plugin, error }) => errors.push(`${plugin}:${error}`));
    const plugins: Plugin[] = [
      { name: "good", apply: () => unwound },
      {
        name: "bad",
        apply: () => {
          throw new Error("apply boom");
        },
      },
    ];
    await expect(loadPlugins(ctx, plugins)).rejects.toThrow("apply boom");
    expect(errors).toEqual(["bad:Error: apply boom"]);
    expect(unwound).toHaveBeenCalledTimes(1); // 已加载的回卷
    expect(() => ctx.on(pluginError, noop)).toThrow(/disposed/); // ctx 整体不可用
  });

  it("apply 中途 throw：本插件已捕获的注册逆序回卷（半装状态不泄漏——件15 收口审查发现）", async () => {
    const ctx = createContext();
    const order: string[] = [];
    await expect(
      loadPlugins(ctx, [
        {
          name: "half",
          apply: (c) => {
            c.effect(() => { order.push("first-out"); });
            c.effect(() => { order.push("second-out"); });
            throw new Error("halfway boom");
          },
        },
      ]),
    ).rejects.toThrow("halfway boom");
    expect(order).toEqual(["second-out", "first-out"]); // 逆序：throw 前的注册全回卷
    await ctx.dispose();
  });

  it("async apply 按序 await", async () => {
    const ctx = createContext();
    const order: string[] = [];
    await loadPlugins(ctx, [
      {
        name: "slow",
        apply: async () => {
          await sleep(5);
          order.push("slow");
        },
      },
      { name: "fast", apply: () => { order.push("fast"); } },
    ]);
    expect(order).toEqual(["slow", "fast"]);
  });
});

// —— S0：softInject 软依赖（SDK-DESIGN §2.1）——

describe("softInject（S0——在场则排后，缺席无约束）", () => {
  it("在场：声明者排在软目标之后（数组序颠倒也保序）", async () => {
    const order: string[] = [];
    const late: Plugin = { name: "late", apply: () => { order.push("late"); } };
    const early: Plugin = { name: "early", softInject: ["late"], apply: () => { order.push("early"); } };
    await loadPlugins(createContext(), [early, late]);
    expect(order).toEqual(["late", "early"]); // 数组序 early 在前——软依赖拉到 late 后
  });

  it("缺席：无约束不报错（按数组序）；未知名不进校验 throw", async () => {
    const order: string[] = [];
    const solo: Plugin = { name: "solo", softInject: ["ghost-absent"], apply: () => { order.push("solo"); } };
    await loadPlugins(createContext(), [solo]);
    expect(order).toEqual(["solo"]); // 缺席软名静默跳过（对照 inject 未知名 → throw）
  });

  it("与 inject 混合：硬先软后；混合环仍被 visiting 栈抓到", async () => {
    const a: Plugin = { name: "a", inject: ["b"], softInject: ["c"], apply: () => {} };
    const b: Plugin = { name: "b", apply: () => {} };
    const c: Plugin = { name: "c", apply: () => {} };
    const unloaded = await loadPlugins(createContext(), [a, b, c]);
    for (const dispose of unloaded) await dispose();
    // 混合环：a softInject b + b inject a
    const x: Plugin = { name: "x", softInject: ["y"], apply: () => {} };
    const y: Plugin = { name: "y", inject: ["x"], apply: () => {} };
    await expect(loadPlugins(createContext(), [x, y])).rejects.toThrow(/cyclic plugin dependency/);
  });

  it("双向软依赖 = 约束矛盾 throw（软-软环不降级为数组序——诚实暴露）", async () => {
    const p: Plugin = { name: "p", softInject: ["q"], apply: () => {} };
    const q: Plugin = { name: "q", softInject: ["p"], apply: () => {} };
    await expect(loadPlugins(createContext(), [p, q])).rejects.toThrow(/cyclic plugin dependency/);
  });

  it("自软锚 throw；硬+软重复声明同一插件无害（done 短路）", async () => {
    const self: Plugin = { name: "self", softInject: ["self"], apply: () => {} };
    await expect(loadPlugins(createContext(), [self])).rejects.toThrow(/cyclic plugin dependency/);
    const a: Plugin = { name: "dup-a", inject: ["dup-b"], softInject: ["dup-b"], apply: () => {} };
    const b: Plugin = { name: "dup-b", apply: () => {} };
    const unloaded = await loadPlugins(createContext(), [a, b]);
    for (const dispose of unloaded) await dispose();
  });
});
