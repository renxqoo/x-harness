import { describe, expect, it, vi } from "vitest";
import { deepFreeze, shellFreeze } from "../freeze.ts";
import { createContext } from "../create-context.ts";
import { loadPlugins } from "../load-plugins.ts";
import { defineEvent } from "../tokens.ts";
import type { Plugin } from "../types.ts";

describe("freeze 边界", () => {
  it("deepFreeze：原始值/null/已冻结对象原样返回", () => {
    expect(deepFreeze(1)).toBe(1);
    expect(deepFreeze(null)).toBe(null);
    expect(deepFreeze(undefined)).toBe(undefined);
    const frozen = Object.freeze({ a: 1 });
    expect(deepFreeze(frozen)).toBe(frozen);
  });

  it("deepFreeze：数组与嵌套数组冻结", () => {
    const value = deepFreeze({ list: [{ x: 1 }] });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.list)).toBe(true);
    expect(Object.isFrozen(value.list[0])).toBe(true);
  });

  it("shellFreeze：原始值/null 不炸、原样返回", () => {
    expect(shellFreeze(1)).toBe(1);
    expect(shellFreeze(null)).toBe(null);
  });
});

describe("注册面垃圾输入", () => {
  it("on 传入 service token → 运行时拒", () => {
    const ctx = createContext();
    expect(() => ctx.on({ kind: "service", name: "s" } as never, () => {})).toThrow(
      "expects an event-like token",
    );
  });
});

describe("加载器垃圾输入", () => {
  it("插件名非法（空/非字符串）→ 预扫描 throw", async () => {
    const ctx = createContext();
    const bad: Plugin[] = [{ name: "", apply: () => {} }];
    await expect(loadPlugins(ctx, bad)).rejects.toThrow("non-empty string");
  });

  it("default sink（未注入时）不炸且后续监听器照常", () => {
    const ctx = createContext(); // 不注入 onListenerError → defaultSink 写 console
    const token = defineEvent<{ v: number }>("evt-default-sink");
    const later = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      ctx.on(token, () => {
        throw new Error("boom");
      });
      ctx.on(token, later);
      expect(() => ctx.emit(token, { v: 1 })).not.toThrow();
      expect(later).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
