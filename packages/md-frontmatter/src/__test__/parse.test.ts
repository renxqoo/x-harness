// parseFlat 表驱动：键值解析与拒注册形态（无冒号/空键 → 整体 undefined）。

import { describe, expect, it } from "vitest";
import { parseFlat } from "../parse.ts";

describe("parseFlat", () => {
  it("单行键值：两侧 trim", () => {
    expect(parseFlat("  name :  a b  ")).toEqual(new Map([["name", "a b"]]));
  });

  it("多行与空行：空行跳过，后续行照常", () => {
    expect(parseFlat("a: 1\n\nb: 2\n")).toEqual(new Map([["a", "1"], ["b", "2"]]));
  });

  it("值为空串合法（冒号后无内容）", () => {
    expect(parseFlat("k:")).toEqual(new Map([["k", ""]]));
  });

  it("值中的冒号保留（首个冒号为分隔符）", () => {
    expect(parseFlat("url: http://x")).toEqual(new Map([["url", "http://x"]]));
  });

  it("值按原样字符串收（内联数组等不解析）", () => {
    expect(parseFlat("tools: [a, b]")).toEqual(new Map([["tools", "[a, b]"]]));
  });

  it("重复键后者覆盖前者", () => {
    expect(parseFlat("k: 1\nk: 2")).toEqual(new Map([["k", "2"]]));
  });

  it.each([
    ["无冒号行", "name"],
    ["空键（冒号在行首）", ": v"],
    ["列表行（连字符开头）", "  - item"],
    ["首行合法次行破坏", "a: 1\nbroken"],
  ])("拒注册形态整体 undefined：%s", (_label, head) => {
    expect(parseFlat(head)).toBeUndefined();
  });

  it("空 head 返回空 Map", () => {
    expect(parseFlat("")).toEqual(new Map());
  });
});
