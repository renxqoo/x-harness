// splitFrontmatter 表驱动：头体边界逐字节断言（形状判定的两侧 + 退化形态）。

import { describe, expect, it } from "vitest";
import { splitFrontmatter } from "../split.ts";

describe("splitFrontmatter", () => {
  it("标准形态：head 为闭合标记间内容，body 为其后全部", () => {
    expect(splitFrontmatter("---\nname: a\n---\nbody text")).toEqual({ head: "name: a", body: "body text" });
  });

  it("body 为空串（闭合即结尾）", () => {
    expect(splitFrontmatter("---\nname: a\n---\n")).toEqual({ head: "name: a", body: "" });
  });

  it("head 含多行与空行原样保留", () => {
    expect(splitFrontmatter("---\nk: v\n\nk2: v2\n---\nb")).toEqual({ head: "k: v\n\nk2: v2", body: "b" });
  });

  it("body 中的后续 --- 行不干扰：首个闭合标记生效", () => {
    expect(splitFrontmatter("---\nk: v\n---\na\n---\nb")).toEqual({ head: "k: v", body: "a\n---\nb" });
  });

  it.each([
    ["无开头标记", "name: a\n---\nbody"],
    ["开头标记后无闭合", "---\nname: a"],
    ["仅开头标记", "---\n"],
    ["空文本", ""],
    ["开头标记前有空白行", "\n---\nk: v\n---\nb"],
    ["闭合标记缺尾随换行", "---\nk: v\n---"],
  ])("退化形态返回 undefined：%s", (_label, text) => {
    expect(splitFrontmatter(text)).toBeUndefined();
  });
});
