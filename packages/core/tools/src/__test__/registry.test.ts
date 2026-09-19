import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { createToolRegistry } from "../registry.ts";
import type { ToolDefinition } from "../types.ts";

function def(name: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    inputSchema: Type.Object({}),
    execute: async () => ({ content: `ok:${name}` }),
    ...overrides,
  };
}

describe("registry（docs/TOOLS.md §1.2）", () => {
  it("register/get/schemas：快照与注册序一致、description 缺省时键缺省", () => {
    const registry = createToolRegistry();
    registry.register(def("b", { description: "B 工具" }));
    registry.register(def("a"));
    expect(registry.get("a")).toBeDefined();
    expect(registry.schemas()).toEqual([
      { name: "b", description: "B 工具", inputSchema: Type.Object({}) },
      { name: "a", inputSchema: Type.Object({}) },
    ]);
  });

  it("重名注册 throw；缺 execute / 空名 throw", () => {
    const registry = createToolRegistry();
    registry.register(def("t"));
    expect(() => registry.register(def("t"))).toThrow('tool "t" already registered');
    expect(() => registry.register(def(""))).toThrow("non-empty string");
    expect(() =>
      registry.register({ name: "x", inputSchema: Type.Object({}), execute: undefined as never }),
    ).toThrow("execute function");
  });

  it("disposer 注销；身份守卫：旧 disposer 不注销重注册的新工具", () => {
    const registry = createToolRegistry();
    const first = def("t");
    const off1 = registry.register(first);
    off1();
    const second = def("t", { execute: async () => ({ content: "v2" }) });
    const off2 = registry.register(second);
    off1(); // 旧 disposer 再跑：身份守卫不动 second
    expect(registry.get("t")).toBe(second);
    off2();
    expect(registry.get("t")).toBeUndefined();
  });

  it("运行期注册新名合法且 schemas 即时反映", () => {
    const registry = createToolRegistry();
    registry.register(def("a"));
    expect(registry.schemas()).toHaveLength(1);
    const off = registry.register(def("b"));
    expect(registry.schemas()).toHaveLength(2);
    off();
    expect(registry.schemas()).toHaveLength(1);
  });
});

describe("concurrencyOf fail-closed（docs/TOOLS.md §1.2）", () => {
  it.each<[string, ToolDefinition | undefined, "parallel" | "exclusive"]>([
    ["严格 true", def("t", { isConcurrencySafe: () => true }), "parallel"],
    ["缺省", def("t"), "exclusive"],
    ["返回 false", def("t", { isConcurrencySafe: () => false }), "exclusive"],
    ["抛错", def("t", { isConcurrencySafe: () => { throw new Error("boom"); } }), "exclusive"],
    ["返回非布尔", def("t", { isConcurrencySafe: () => "yes" as never }), "exclusive"],
    ["未知工具", undefined, "exclusive"],
  ])("%s", (_name, tool, expected) => {
    const registry = createToolRegistry();
    if (tool !== undefined) registry.register(tool);
    expect(registry.concurrencyOf("t", {})).toBe(expected);
  });
});
