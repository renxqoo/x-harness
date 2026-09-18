import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { formatArgsEcho, probeSchema, violationsOf } from "../validate.ts";

describe("TypeBox 校验封装（docs/TOOLS.md §1.4）", () => {
  it("合法值无违规", () => {
    expect(violationsOf(Type.Object({ a: Type.String() }), { a: "x" })).toBeUndefined();
    expect(violationsOf(Type.Object({ a: Type.Optional(Type.String()) }), {})).toBeUndefined();
    expect(violationsOf(Type.Object({ a: Type.Optional(Type.String()) }), { a: undefined })).toBeUndefined();
  });

  it.each<[string, unknown, unknown]>([
    ["string 反例", Type.String(), 5],
    ["number 反例", Type.Number(), "5"],
    ["integer 1.5", Type.Integer(), 1.5],
    ["integer NaN", Type.Integer(), Number.NaN],
    ["boolean 反例", Type.Boolean(), "yes"],
    ["缺 required", Type.Object({ a: Type.String() }), {}],
    ["嵌套 object 反例", Type.Object({ a: Type.Object({ b: Type.String() }) }), { a: { b: 5 } }],
    ["array items 反例", Type.Array(Type.String()), [1, "ok"]],
    ["enum 反例", Type.Union([Type.Literal("a"), Type.Literal("b")]), "c"],
  ])("%s → 有违规", (_name, schema, value) => {
    expect(violationsOf(schema as never, value)).toBeDefined();
  });

  it("违规清单带 path 与信息", () => {
    const violations = violationsOf(Type.Object({ a: Type.Object({ b: Type.String() }) }), { a: { b: 5 } });
    expect(violations).toContain("/a/b");
    expect(violations).toContain("Expected string");
  });

  it("严格校验：Optional 传 null 违规（无强制转换）", () => {
    expect(violationsOf(Type.Object({ a: Type.Optional(Type.String()) }), { a: null })).toBeDefined();
  });

  it("args 为 undefined / 字符串原文（loop 保留无效 JSON 原文）→ 违规可回显", () => {
    expect(violationsOf(Type.Object({ a: Type.String() }), undefined)).toBeDefined();
    expect(violationsOf(Type.Object({ a: Type.String() }), "{bad json")).toBeDefined();
  });

  it("formatArgsEcho：循环引用与 undefined 兜底", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(formatArgsEcho(cyclic)).toBe("<unserializable args>");
    expect(formatArgsEcho(undefined)).toBe("undefined");
    expect(formatArgsEcho({ a: 1 })).toBe('{"a":1}');
  });

  it("register 探活（结构性 Kind 巡检）：垃圾 schema throw、合法 Type.* 过", () => {
    expect(() => probeSchema({ type: "object" } as never)).toThrow(); // 无 [Kind] 派发
    expect(() => probeSchema(5 as never)).toThrow();
    expect(() => probeSchema(null)).toThrow();
    expect(() => probeSchema(Type.Object({ a: Type.String() }))).not.toThrow();
    expect(() => probeSchema(Type.Object({ a: Type.Optional(Type.String()) }))).not.toThrow();
    expect(() => probeSchema(Type.Array(Type.Object({ b: Type.String() })))).not.toThrow();
    expect(() =>
      probeSchema(Type.Union([Type.String(), Type.Object({ b: Type.String() })])),
    ).not.toThrow();
  });

  it("探活抓到 optional/items 下的无 Kind 垃圾节点（F2 回归：探活值驱动对零错误路径不求值）", () => {
    const crafted = { ...Type.Object({ a: Type.Optional(Type.String()) }), properties: { a: { type: "string" } } };
    expect(() => probeSchema(crafted)).toThrow("missing-kind");
    const craftedArray = { ...Type.Array(Type.String()), items: { type: "string" } };
    expect(() => probeSchema(craftedArray)).toThrow("missing-kind");
    const numberGarbage = { ...Type.Object({ a: Type.String() }), properties: { a: 5 } };
    expect(() => probeSchema(numberGarbage)).toThrow("not-object");
  });

  it("formatArgsEcho：Symbol/BigInt 根值回显不误报 undefined（F7 回归）", () => {
    expect(formatArgsEcho(Symbol("s"))).toBe("Symbol(s)");
    expect(formatArgsEcho(10n)).toBe("10");
  });
});
