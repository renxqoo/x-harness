import { describe, expect, it } from "vitest";
import { createContext } from "../create-context.ts";
import { defineEvent, defineService } from "../tokens.ts";

describe("scope 层链（§3）", () => {
  it("子层 dispose 只回卷本层：父层注册完好", async () => {
    const ctx = createContext();
    const token = defineEvent<{ v: number }>("evt");
    const rootHeard: number[] = [];
    const childHeard: number[] = [];
    ctx.on(token, ({ v }) => rootHeard.push(v));
    const child = ctx.scope({ agentId: "a" });
    child.on(token, ({ v }) => childHeard.push(v));
    await child.dispose();
    ctx.emit(token, { v: 1 });
    expect(rootHeard).toEqual([1]);
    expect(childHeard).toEqual([]);
    // 子层 dispose 后不能再注册
    expect(() => child.on(token, () => {})).toThrow(/disposed/);
  });

  it("父层 dispose 收编未显式 dispose 的子层（scope 创建入父账本）", async () => {
    const ctx = createContext();
    const token = defineEvent<{ v: number }>("evt");
    const childHeard: number[] = [];
    const child = ctx.scope({ agentId: "a" });
    child.on(token, ({ v }) => childHeard.push(v));
    await ctx.dispose();
    ctx.emit(token, { v: 1 }); // emit 在 dispose 后允许（unwind 边界）
    expect(childHeard).toEqual([]); // 子层注册已被父回卷带走
  });

  it("孙层链：三层并集可见、depth 排序", () => {
    const ctx = createContext();
    const mid = ctx.scope({ agentId: "mid" });
    const leaf = mid.scope({ agentId: "leaf" });
    const token = defineEvent<{ v: number }>("evt");
    const order: string[] = [];
    leaf.on(token, () => order.push("leaf"));
    mid.on(token, () => order.push("mid"));
    ctx.on(token, () => order.push("root"));
    leaf.emit(token, { v: 1 });
    expect(order).toEqual(["root", "mid", "leaf"]);
    // 中间层 emit：leaf 监听者不可见
    order.length = 0;
    mid.emit(token, { v: 1 });
    expect(order).toEqual(["root", "mid"]);
  });

  it("兄弟 scope 服务隔离：各自 provide 互不可见（§10 风险 3 的服务面）", () => {
    const ctx = createContext();
    const token = defineService<{ who: string }>("owner");
    const a = ctx.scope({ agentId: "a" });
    const b = ctx.scope({ agentId: "b" });
    a.provide(token, { who: "a" });
    b.provide(token, { who: "b" });
    expect(a.use(token).who).toBe("a");
    expect(b.use(token).who).toBe("b");
    expect(ctx.tryUse(token)).toBeUndefined(); // root 无此服务
  });

  it("disposed 层上 scope/dispatch 拒绝", async () => {
    const ctx = createContext();
    const child = ctx.scope({ agentId: "a" });
    await child.dispose();
    expect(() => child.scope({ agentId: "b" })).toThrow(/disposed/);
    const wfToken = { kind: "waterfall", mode: "waterfall", name: "w" } as never;
    const serialToken = { kind: "serial", mode: "serial", name: "s" } as never;
    const guardToken = { kind: "guard", mode: "guard", name: "g" } as never;
    await expect(child.dispatch(wfToken, 1, async () => 1)).rejects.toThrow(/disposed/);
    await expect(child.dispatch(serialToken, 1)).rejects.toThrow(/disposed/);
    await expect(child.dispatch(guardToken, 1)).rejects.toThrow(/disposed/);
  });
});
