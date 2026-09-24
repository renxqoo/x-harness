// edit 纯函数域测试（docs/EDIT-TOOL.md 测试口径）：精确/模糊/唯一性/重叠/原子性/
// 归一附带损伤/CRLF+BOM\u2014\u2014pi 全集起列 + 三审查修正各自的回归断言。

import { describe, expect, it } from "vitest";
import {
  splitBom,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  normalizeForFuzzyMatch,
  findText,
  applyEditsToNormalizedContent,
} from "../edit-apply.ts";

const F = "/f.ts";

describe("edit-apply 文本形态工具", () => {
  it("splitBom 剥离并还原 BOM", () => {
    expect(splitBom("\uFEFFabc")).toEqual({ bom: "\uFEFF", text: "abc" });
    expect(splitBom("abc")).toEqual({ bom: "", text: "abc" });
  });

  it("detectLineEnding 首见启发式", () => {
    expect(detectLineEnding("a\r\nb\nc")).toBe("\r\n");
    expect(detectLineEnding("a\nb\r\nc")).toBe("\n");
    expect(detectLineEnding("a\rb")).toBe("\n");
    expect(detectLineEnding("abc")).toBe("\n");
  });

  it("normalizeToLF/restoreLineEndings 逆往返", () => {
    const crlf = "a\r\nb\r\nc";
    expect(normalizeToLF(crlf)).toBe("a\nb\nc");
    expect(restoreLineEndings(normalizeToLF(crlf), "\r\n")).toBe(crlf);
    expect(normalizeToLF("a\rb")).toBe("a\nb");
  });

  it("五归一各形：NFKC/行尾空白/智能引号/破折号/特殊空格", () => {
    expect(normalizeForFuzzyMatch("\u2460")).toBe("1");
    expect(normalizeForFuzzyMatch("line   \nnext")).toBe("line\nnext");
    expect(normalizeForFuzzyMatch("\u2018a\u2019 \u201Cb\u201D \u201Ac\u201B \u201Ed\u201C")).toBe("'a' \"b\" 'c' \"d\"");
    expect(normalizeForFuzzyMatch("\u2010 \u2013 \u2014 \u2015 \u2212")).toBe("- - - - -");
    expect(normalizeForFuzzyMatch("a\u00A0b\u2002c\u3000d")).toBe("a b c d");
  });

  it("NBSP 单字符归一后为空（拒绝前置检查的依据）", () => {
    expect(normalizeForFuzzyMatch("\u00A0")).toBe("");
  });
});

describe("findText 精确优先", () => {
  it("精确命中返回原文与偏移", () => {
    const r = findText("abcXdef", "X");
    expect(r).toEqual({ found: true, index: 3, matchLength: 1, usedFuzzyMatch: false, contentForReplacement: "abcXdef" });
  });

  it("精确失败走归一空间并给归一偏移", () => {
    const r = findText("a \u201Cb\u201D c", '"b"');
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.usedFuzzyMatch).toBe(true);
      expect(r.matchLength).toBe(3);
      expect(r.contentForReplacement).toBe('a "b" c');
      expect(r.contentForReplacement.slice(r.index, r.index + r.matchLength)).toBe('"b"');
    }
  });

  it("未命中与归一后空两种拒因可区分（A 件 2）", () => {
    expect(findText("abc", "zzz")).toEqual({ found: false, reason: "not-found" });
    expect(findText("a b", "\u00A0")).toEqual({ found: false, reason: "empty-after-normalize" });
  });
});

describe("applyEditsToNormalizedContent 精确域", () => {
  it("单 edit 精确命中", () => {
    const r = applyEditsToNormalizedContent("const a = 1;\nconst b = 2;\n", [{ oldText: "const a = 1;", newText: "let a = 1;" }], F);
    expect(r).toEqual({ ok: true, baseContent: "const a = 1;\nconst b = 2;\n", newContent: "let a = 1;\nconst b = 2;\n" });
  });

  it("多处命中拒 DUPLICATE 且文案注明精确计数空间（A 件 4）", () => {
    const r = applyEditsToNormalizedContent("x\nx\n", [{ oldText: "x", newText: "y" }], F);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.startsWith("DUPLICATE: found 2 occurrences")).toBe(true);
      expect(r.reason).toContain("(counted in exact space)");
    }
  });

  it("未命中拒 NOT_FOUND 并引导 re-read（B2b）", () => {
    const r = applyEditsToNormalizedContent("a\n", [{ oldText: "zz", newText: "y" }], F);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.startsWith("NOT_FOUND")).toBe(true);
      expect(r.reason).toContain("re-read it first");
      expect(r.reason).toContain("including all whitespace and newlines");
    }
  });

  it("空 oldText 拒 EMPTY_OLD_TEXT", () => {
    const r = applyEditsToNormalizedContent("a\n", [{ oldText: "", newText: "y" }], F);
    expect(r).toEqual({ ok: false, reason: "EMPTY_OLD_TEXT: oldText must not be empty (/f.ts)" });
  });

  it("多 edit 下空 oldText 指明条目下标", () => {
    const r = applyEditsToNormalizedContent("a\nb\n", [{ oldText: "a", newText: "x" }, { oldText: "", newText: "y" }], F);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("edits[1]");
  });

  it("无变化拒 NO_CHANGE", () => {
    const r = applyEditsToNormalizedContent("a\n", [{ oldText: "a", newText: "a" }], F);
    expect(r).toEqual({ ok: false, reason: "NO_CHANGE: replacements produced identical content in /f.ts" });
  });
});

describe("applyEditsToNormalizedContent 原子性与偏移", () => {
  const three = "l1\nl2\nl3\n";

  it("部分失败不产生 newContent（全批拒）", () => {
    const r = applyEditsToNormalizedContent(three, [
      { oldText: "l1", newText: "x1" },
      { oldText: "nope", newText: "x2" },
    ], F);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/^NOT_FOUND/) } as never);
  });

  it("多 edit 逆序应用偏移稳定（列表序与文档序相反也不串位）", () => {
    const reversed = applyEditsToNormalizedContent(three, [
      { oldText: "l3", newText: "L3" },
      { oldText: "l1", newText: "L1" },
    ], F);
    expect(reversed).toEqual({ ok: true, baseContent: three, newContent: "L1\nl2\nL3\n" });
    const forward = applyEditsToNormalizedContent(three, [
      { oldText: "l1", newText: "L1" },
      { oldText: "l3", newText: "L3" },
    ], F);
    expect(forward.ok && forward.newContent).toBe("L1\nl2\nL3\n");
  });

  it("重叠拒 OVERLAP 并提示合并", () => {
    const r = applyEditsToNormalizedContent("abcdef\n", [
      { oldText: "bcd", newText: "X" },
      { oldText: "cde", newText: "Y" },
    ], F);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.startsWith("OVERLAP")).toBe(true);
      expect(r.reason).toContain("Merge them into one edit");
    }
  });

  it("重叠口径=字符串偏移：同行不相交两 edit 放行（A 件 3）", () => {
    const r = applyEditsToNormalizedContent("abcdef\n", [
      { oldText: "ab", newText: "X" },
      { oldText: "ef", newText: "Y" },
    ], F);
    expect(r.ok && r.newContent).toBe("XcdY\n");
  });

  it("相邻贴边（prevEnd === curStart）不算重叠", () => {
    const r = applyEditsToNormalizedContent("abcdef\n", [
      { oldText: "abc", newText: "X" },
      { oldText: "def", newText: "Y" },
    ], F);
    expect(r.ok && r.newContent).toBe("XY\n");
  });
});

describe("applyEditsToNormalizedContent 模糊域（pi 踩坑面）", () => {
  it("智能引号差异走模糊命中且换对位置", () => {
    const content = 'before\nconst s = "keep";\nconst t = "old";\nafter\n';
    const r = applyEditsToNormalizedContent(content, [{ oldText: 'const t = \u201Cold\u201D;', newText: "const t = 'new';" }], F);
    expect(r.ok && r.newContent).toBe("before\nconst s = \"keep\";\nconst t = 'new';\nafter\n");
  });

  it("NBSP 单字符 oldText 归一后为空 → EMPTY_OLD_TEXT（A 件 2 回归）", () => {
    const r = applyEditsToNormalizedContent("a b\n", [{ oldText: "\u00A0", newText: " " }], F);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.startsWith("EMPTY_OLD_TEXT")).toBe(true);
      expect(r.reason).toContain("normalizes to empty");
    }
  });

  it("归一后为空的 oldText 混在其他可命中 edit 中也全批拒", () => {
    const r = applyEditsToNormalizedContent("a\n", [
      { oldText: "a", newText: "x" },
      { oldText: "\u3000", newText: " " },
    ], F);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.startsWith("EMPTY_OLD_TEXT")).toBe(true);
  });

  it("精确优先于模糊：文件同时存在精确命中与可模糊命中处走精确（未触行字节保真）", () => {
    const content = 'msg = "exact"\nother = \u201Cfuzzy\u201D\n';
    const r = applyEditsToNormalizedContent(content, [{ oldText: 'msg = "exact"', newText: "msg = 1" }], F);
    expect(r.ok && r.newContent).toBe('msg = 1\nother = \u201Cfuzzy\u201D\n');
  });

  it("唯一性口径：精确唯一但归一多处 → 放行精确（C1/A 件 4）", () => {
    const content = 'a = "x"\nb = \u201Cx\u201D\n';
    const r = applyEditsToNormalizedContent(content, [{ oldText: 'a = "x"', newText: "a = 1" }], F);
    expect(r.ok && r.newContent).toBe("a = 1\nb = \u201Cx\u201D\n");
  });

  it("归一后重复 → DUPLICATE 独立触发面（文案注明归一计数空间）", () => {
    const content = 'a = "x"\nb = "x"\n';
    const r = applyEditsToNormalizedContent(content, [{ oldText: "\u201Cx\u201D", newText: "a = 1" }], F);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.startsWith("DUPLICATE: found 2 occurrences")).toBe(true);
      expect(r.reason).toContain("(counted in normalized space)");
    }
  });
});

describe("模糊域行块保真（pi fuzzy-preserve-duplicate-line 真坑）", () => {
  it("邻行同文：模糊替换落在正确出现位置", () => {
    const content = "const a = \u201Cdup\u201D;\nkeep1\nconst b = \u201Cdup\u201D;\n";
    const r = applyEditsToNormalizedContent(content, [{ oldText: "const b = \u201Cdup\u201D;", newText: "const b = 2;" }], F);
    expect(r.ok && r.newContent).toBe("const a = \u201Cdup\u201D;\nkeep1\nconst b = 2;\n");
  });

  it("未触行保持原始字节（智能引号/行尾空白不被波及）", () => {
    const content = 'keep \u201Cquotes\u201D  \ntarget \u201Cold\u201D\nkeep2 \u201Cmore\u201D  \n';
    const r = applyEditsToNormalizedContent(content, [{ oldText: "target \u201Cold\u201D", newText: "target new" }], F);
    expect(r.ok && r.newContent).toBe('keep \u201Cquotes\u201D  \ntarget new\nkeep2 \u201Cmore\u201D  \n');
  });

  it("附带损伤固化为断言：命中行匹配区外的智能引号被归一、触碰块内行尾空白被剥（A 件 7）", () => {
    const content = 'line \u201Cq\u201D tail  \n';
    const r = applyEditsToNormalizedContent(content, [{ oldText: 'line "q" tail', newText: "done" }], F);
    expect(r.ok && r.newContent).toBe("done\n");
  });

  it("多 edit 混合精确/模糊（批次基底切换后精确条目也在归一空间命中）", () => {
    const content = 'plain = "a"\nfancy = \u201Cb\u201D\n';
    const r = applyEditsToNormalizedContent(content, [
      { oldText: 'plain = "a"', newText: "plain = 1" },
      { oldText: "fancy = \u201Cb\u201D", newText: "fancy = 2" },
    ], F);
    expect(r.ok && r.newContent).toBe("plain = 1\nfancy = 2\n");
  });

  it("行尾空白差异走模糊（归一剥离行尾空白后命中）", () => {
    const content = "code   \nnext\n";
    const r = applyEditsToNormalizedContent(content, [{ oldText: "code\nnext", newText: "renamed\nnext" }], F);
    expect(r.ok && r.newContent).toBe("renamed\nnext\n");
  });
});

describe("CRLF/BOM 形态（7 例规模）", () => {
  it("LF oldText 对 CRLF 文件（先 LF 归一再匹配）", () => {
    const content = "a\r\nb\r\nc\r\n";
    const r = applyEditsToNormalizedContent(normalizeToLF(content), [{ oldText: "b", newText: "B" }], F);
    expect(r.ok && restoreLineEndings(r.newContent, detectLineEnding(content))).toBe("a\r\nB\r\nc\r\n");
  });

  it("跨行尾形态的重复检测：CRLF 处与 LF 处归一后同文 → DUPLICATE", () => {
    const content = "x\r\nmid\nx\n";
    const r = applyEditsToNormalizedContent(normalizeToLF(content), [{ oldText: "x", newText: "y" }], F);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.startsWith("DUPLICATE: found 2 occurrences")).toBe(true);
  });

  it("CRLF/LF 混合文件多 edit", () => {
    const content = "one\r\ntwo\nthree\r\n";
    const r = applyEditsToNormalizedContent(normalizeToLF(content), [
      { oldText: "one", newText: "1" },
      { oldText: "three", newText: "3" },
    ], F);
    expect(r.ok && r.newContent).toBe("1\ntwo\n3\n");
  });

  it("CRLF 文件整链路保真：归一→应用→还原", () => {
    const crlf = "function f() {\r\n  return 1;\r\n}\r\n";
    const r = applyEditsToNormalizedContent(normalizeToLF(crlf), [{ oldText: "return 1;", newText: "return 2;" }], F);
    expect(r.ok && restoreLineEndings(r.newContent, detectLineEnding(crlf))).toBe("function f() {\r\n  return 2;\r\n}\r\n");
  });

  it("CRLF oldText 直接给（含 \r\n）也能命中", () => {
    const r = applyEditsToNormalizedContent("a\nb\nc\n", [{ oldText: "b\r\nc", newText: "B" }], F);
    expect(r.ok && r.newContent).toBe("a\nB\n");
  });

  it("BOM+CRLF 叠加：splitBom 剥离后整链路保真", () => {
    const raw = "\uFEFFa\r\nb\r\n";
    const { bom, text } = splitBom(raw);
    const r = applyEditsToNormalizedContent(normalizeToLF(text), [{ oldText: "a", newText: "A" }], F);
    expect(bom).toBe("\uFEFF");
    expect(r.ok && bom + restoreLineEndings(r.newContent, detectLineEnding(text))).toBe("\uFEFFA\r\nb\r\n");
  });

  it("BOM round-trip：无 BOM 文件编辑后不引入 BOM", () => {
    const { bom } = splitBom("a\n");
    const r = applyEditsToNormalizedContent("a\n", [{ oldText: "a", newText: "b" }], F);
    expect(bom).toBe("");
    expect(r.ok && bom + r.newContent).toBe("b\n");
  });
});

describe("模糊域行块分组", () => {
  it("批次内某条精确失败、其余条目归一后空 → EMPTY_OLD_TEXT 先于 NOT_FOUND", () => {
    const r = applyEditsToNormalizedContent("a b\n", [
      { oldText: "zz", newText: "x" },
      { oldText: "\u3000", newText: " " },
    ], F);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.startsWith("EMPTY_OLD_TEXT")).toBe(true);
      expect(r.reason).toContain("edits[1]");
    }
  });

  it("同块合并：相邻贴边的两条模糊 edit 落进同一行块仍正确应用", () => {
    const content = "a “x” b “y” c\n";
    const r = applyEditsToNormalizedContent(content, [
      { oldText: '"x"', newText: "1" },
      { oldText: '"y"', newText: "2" },
    ], F);
    expect(r.ok && r.newContent).toBe("a 1 b 2 c\n");
  });
});
