import { describe, expect, it, vi } from "vitest";
import { createContext } from "../create-context.ts";
import { defineEvent } from "../tokens.ts";

describe("emit 派发（§2.2 矩阵第一行）", () => {
  it("注册序执行（多播并集不遮蔽）", () => {
    const ctx = createContext();
    const token = defineEvent<{ v: number }>("evt");
    const order: number[] = [];
    ctx.on(token, ({ v }) => order.push(v * 10));
    ctx.on(token, ({ v }) => order.push(v * 100));
    ctx.emit(token, { v: 1 });
    expect(order).toEqual([10, 100]);
  });

  it("payload 深冻结（strict 写入 throw）", () => {
    const ctx = createContext();
    const token = defineEvent<{ nested: { x: number } }>("evt-deep");
    let seen: { nested: { x: number } } | undefined;
    ctx.on(token, (p) => {
      seen = p;
    });
    ctx.emit(token, { nested: { x: 1 } });
    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen?.nested)).toBe(true);
    expect(() => {
      (seen as { v?: number }).v = 1;
    }).toThrow(TypeError);
  });

  it("freeze none 豁免：不冻结", () => {
    const ctx = createContext();
    const token = defineEvent<{ x: number }>("evt-none", { freeze: "none" });
    let seen: { x: number } | undefined;
    ctx.on(token, (p) => {
      seen = p;
    });
    ctx.emit(token, { x: 1 });
    expect(Object.isFrozen(seen)).toBe(false);
  });

  it("监听器错误隔离：后续照常、错误进 sink（I3）", () => {
    const sink = vi.fn();
    const ctx = createContext({ onListenerError: sink });
    const token = defineEvent<{ v: number }>("evt-iso");
    const later = vi.fn();
    ctx.on(token, () => {
      throw new Error("boom");
    });
    ctx.on(token, later);
    ctx.emit(token, { v: 1 });
    expect(later).toHaveBeenCalledWith({ v: 1 });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[1]).toMatchObject({ name: "evt-iso" });
  });

  it("sink 自身失败不中断派发链（§2.4）", () => {
    const ctx = createContext({
      onListenerError: () => {
        throw new Error("sink broken");
      },
    });
    const token = defineEvent<{ v: number }>("evt-sink");
    const later = vi.fn();
    ctx.on(token, () => {
      throw new Error("boom");
    });
    ctx.on(token, later);
    expect(() => ctx.emit(token, { v: 1 })).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("disposer 退订；晚订阅不回放（错过不补）", () => {
    const ctx = createContext();
    const token = defineEvent<{ v: number }>("evt-late");
    const heard: number[] = [];
    const stop = ctx.on(token, ({ v }) => heard.push(v));
    ctx.emit(token, { v: 1 });
    stop();
    ctx.emit(token, { v: 2 });
    expect(heard).toEqual([1]);
    ctx.on(token, ({ v }) => heard.push(v));
    expect(heard).toEqual([1]); // 新监听者不回放历史
  });

  it("chain-up：子层 emit 祖先可见、兄弟不可见（C3）", () => {
    const ctx = createContext();
    const a = ctx.scope({ agentId: "a" });
    const b = ctx.scope({ agentId: "b" });
    const token = defineEvent<{ v: number }>("evt-chain");
    const rootHeard: number[] = [];
    const bHeard: number[] = [];
    ctx.on(token, ({ v }) => rootHeard.push(v));
    b.on(token, ({ v }) => bHeard.push(v));
    a.emit(token, { v: 1 });
    expect(rootHeard).toEqual([1]); // 祖先可见
    expect(bHeard).toEqual([]); // 兄弟不可见
  });

  it("监听并集 root→leaf 次序：root 晚注册仍先执行（C2）", () => {
    const ctx = createContext();
    const child = ctx.scope({ agentId: "a" });
    const token = defineEvent<{ v: number }>("evt-order");
    const order: string[] = [];
    child.on(token, () => order.push("child"));
    ctx.on(token, () => order.push("root")); // 晚于 child 注册
    child.emit(token, { v: 1 }); // 从 child emit：链上并集可见
    expect(order).toEqual(["root", "child"]);
    // 从 root emit：child 监听者不可见（chain-up 单向）
    order.length = 0;
    ctx.emit(token, { v: 2 });
    expect(order).toEqual(["root"]);
  });

  it("emit 同步可重入（§2.5）", () => {
    const ctx = createContext();
    const token = defineEvent<{ v: number }>("evt-reentrant");
    const calls: number[] = [];
    ctx.on(token, function relay(payload) {
      calls.push(payload.v);
      if (payload.v < 3) ctx.emit(token, { v: payload.v + 1 });
    });
    ctx.emit(token, { v: 1 });
    expect(calls).toEqual([1, 2, 3]);
  });

  it("非 event token emit → 运行时拒", () => {
    const ctx = createContext();
    const fake = { kind: "service", name: "x" } as never;
    expect(() => ctx.emit(fake, {})).toThrow("expects an event token");
  });
});
