// replaceFlatField 表驱动（docs/SKILL-INSTALL.md §1.1）：last-wins 替换点、头体字节
// 保真、不可替换形态整体 undefined（无 frontmatter/键缺席/键值形态非法）。

import { describe, expect, it } from "vitest";
import { replaceFlatField } from "../replace.ts";

describe("replaceFlatField", () => {
  it("替换唯一命中行：头体其余字节逐字保真", () => {
    const text = "---\nname: old\ndescription: does A\n---\nbody\nline2\n";
    expect(replaceFlatField(text, "name", "new")).toBe("---\nname: new\ndescription: does A\n---\nbody\nline2\n");
  });

  it("重复键：替换最后一次出现的行（与 parseFlat last-wins 读取同义）", () => {
    const text = "---\nname: first\ndescription: x\nname: second\n---\n";
    const replaced = replaceFlatField(text, "name", "final");
    expect(replaced).toBe("---\nname: first\ndescription: x\nname: final\n---\n");
    expect(replaced?.match(/name: /g)).toHaveLength(2);
  });

  it("键两侧空白与值原样形态：命中判定按 trim 后的键（与 parseFlat 同法）", () => {
    expect(replaceFlatField("---\n name : old \n---\n", "name", "new")).toBe("---\nname: new\n---\n");
  });

  it("空 body 与无尾换行：原样保留", () => {
    expect(replaceFlatField("---\nname: old\n---\n", "name", "new")).toBe("---\nname: new\n---\n");
  });

  it("值含冒号合法（首个冒号为分隔符——形态不变）", () => {
    expect(replaceFlatField("---\nurl: old\n---\n", "url", "http://x")).toBe("---\nurl: http://x\n---\n");
  });

  it.each([
    { label: "无 frontmatter 包夹", text: "name: old\n", key: "name", value: "new" },
    { label: "键缺席", text: "---\ndescription: x\n---\n", key: "name", value: "new" },
    { label: "头内无冒号行（不可解析头）", text: "---\nbroken\n---\n", key: "name", value: "new" },
    { label: "空键", text: "---\nname: old\n---\n", key: "", value: "new" },
    { label: "键含冒号", text: "---\nname: old\n---\n", key: "a:b", value: "new" },
    { label: "键含两侧空白", text: "---\nname: old\n---\n", key: " name ", value: "new" },
    { label: "值含换行（注入字段行）", text: "---\nname: old\n---\n", key: "name", value: "a\nb" },
    { label: "值含回车", text: "---\nname: old\n---\n", key: "name", value: "a\rb" },
  ])("不可替换形态 → undefined：$label", ({ text, key, value }) => {
    expect(replaceFlatField(text, key, value)).toBeUndefined();
  });
});
