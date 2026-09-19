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
