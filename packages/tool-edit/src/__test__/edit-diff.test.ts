// edit diff 组装测试（docs/EDIT-TOOL.md）：双轨行号/上下文窗口/firstChangedLine/空文件。

import { describe, expect, it } from "vitest";
import { generateDiffString } from "../edit-diff.ts";

describe("generateDiffString 双轨行号", () => {
  it("变更行 +N/-N 各自计数，上下文行取旧轨", () => {
    const old = "a\nb\nc\nd\ne\n";
    const now = "a\nB\nc\nd\nE\n";
    const { diff } = generateDiffString(old, now);
    const lines = diff.split("\n");
    expect(lines).toEqual([" 1 a", "-2 b", "+2 B", " 3 c", " 4 d", "-5 e", "+5 E"]);
  });

  it("纯新增行只推进新轨", () => {
    const { diff, firstChangedLine } = generateDiffString("a\nb\n", "a\nx\nb\n");
    expect(diff.split("\n")).toEqual([" 1 a", "+2 x", " 2 b"]);
    expect(firstChangedLine).toBe(2);
  });

  it("纯删除行只推进旧轨", () => {
    const { diff, firstChangedLine } = generateDiffString("a\nb\nc\n", "a\nc\n");
    expect(diff.split("\n")).toEqual([" 1 a", "-2 b", " 3 c"]);
    expect(firstChangedLine).toBe(2);
  });

  it("首行变更 firstChangedLine=1", () => {
    const { firstChangedLine } = generateDiffString("a\n", "z\n");
    expect(firstChangedLine).toBe(1);
  });

  it("相同内容无变更：diff 空串、firstChangedLine undefined", () => {
    expect(generateDiffString("a\nb\n", "a\nb\n")).toEqual({ diff: "", firstChangedLine: undefined });
  });

  it("行号宽度按最大行数补齐", () => {
    const old = `${Array.from({ length: 12 }, (_, i) => `l${String(i)}`).join("\n")}\n`;
    const now = old.replace("l10", "X");
    const { diff } = generateDiffString(old, now);
    const changed = diff.split("\n").find((l) => l.startsWith("+"));
    expect(changed).toBe("+11 X");
  });
});

describe("generateDiffString 上下文窗口", () => {
  const mk = (n: number): string => `${Array.from({ length: n }, (_, i) => `l${String(i + 1)}`).join("\n")}\n`;

  it("默认 4 行上下文且中段折叠为省略行", () => {
    const old = mk(20);
    const now = old.replace("l10", "X");
    const lines = generateDiffString(old, now).diff.split("\n");
    // 前导 4 行上下文（l5-l8 是 4 行）+ 省略 + 尾随 4 行（l11-l14）
    expect(lines).toContain("  9 l9");
    expect(lines).toContain(" 11 l11");
    expect(lines).toContain("    ...");
    expect(lines).not.toContain("  5 l5");
    expect(lines).toContain(" 14 l14");
    expect(lines.filter((l) => l === "  6 l6" || l === "  5 l5")).toEqual(["  6 l6"]);
    expect(lines.filter((l) => l === " 15 l15" || l === " 16 l16")).toEqual([]);
  });

  it("自定义 contextLines 窗口收窄", () => {
    const old = mk(12);
    const now = old.replace("l6", "X");
    const lines = generateDiffString(old, now, 1).diff.split("\n");
    expect(lines).toEqual(["    ...", "  5 l5", "- 6 l6", "+ 6 X", "  7 l7", "    ..."]);
  });

  it("开头变更只有尾随上下文（无前导省略）", () => {
    const old = mk(10);
    const now = old.replace("l1", "X");
    const lines = generateDiffString(old, now).diff.split("\n");
    expect(lines[0]).toBe("- 1 l1");
    expect(lines[1]).toBe("+ 1 X");
    expect(lines).toContain("  2 l2");
    expect(lines.length).toBe(7);
  });

  it("结尾变更只有前导上下文（前导省略行开头）", () => {
    const old = mk(10);
    const now = old.replace("l10", "X");
    const lines = generateDiffString(old, now).diff.split("\n");
    expect(lines[0]).toBe("    ...");
    expect(lines[1]).toBe("  6 l6");
    expect(lines.at(-1)).toBe("+10 X");
    expect(lines.filter((l) => l.trim() === "...").length).toBe(1);
  });
});

describe("generateDiffString 边界", () => {
  it("空旧文件：全部为新增行", () => {
    const { diff, firstChangedLine } = generateDiffString("", "a\nb\n");
    expect(diff.split("\n")).toEqual(["+1 a", "+2 b"]);
    expect(firstChangedLine).toBe(1);
  });

  it("空新文件：全部为删除行", () => {
    const { diff, firstChangedLine } = generateDiffString("a\nb\n", "");
    expect(diff.split("\n")).toEqual(["-1 a", "-2 b"]);
    expect(firstChangedLine).toBe(1);
  });

  it("双侧皆空", () => {
    expect(generateDiffString("", "")).toEqual({ diff: "", firstChangedLine: undefined });
  });

  it("末行无换行符不产生幽灵空行", () => {
    const { diff } = generateDiffString("a\nb", "a\nB");
    expect(diff.split("\n")).toEqual([" 1 a", "-2 b", "+2 B"]);
  });

  it("多 edit 混合增删（edit 工具回显的典型形态）", () => {
    const old = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    const now = "let a = 1;\nconst c = 3;\nconst d = 4;\n";
    const { diff, firstChangedLine } = generateDiffString(old, now);
    expect(diff.split("\n")).toEqual(["-1 const a = 1;", "-2 const b = 2;", "+1 let a = 1;", " 3 const c = 3;", "+3 const d = 4;"]);
    expect(firstChangedLine).toBe(1);
  });
});

describe("generateDiffString 多处变更中段折叠", () => {
  it("双侧夹变更的上下文块超过 2×contextLines 时折叠中段并双轨同步推进", () => {
    const mk = (n: number): string => `${Array.from({ length: n }, (_, i) => `l${String(i + 1)}`).join("\n")}\n`;
    // 两处变更（l4 与 l16），中间 l5-l15 共 11 行上下文 > 2×4=8 → 折叠中段
    const old = mk(20);
    const now = old.replace("l4", "X4").replace("l16", "Y16");
    const { diff, firstChangedLine } = generateDiffString(old, now);
    const lines = diff.split("\n");
    expect(lines).toEqual([
      "  1 l1", "  2 l2", "  3 l3",
      "- 4 l4", "+ 4 X4",
      "  5 l5", "  6 l6", "  7 l7", "  8 l8",
      "    ...",
      " 12 l12", " 13 l13", " 14 l14", " 15 l15",
      "-16 l16", "+16 Y16",
      " 17 l17", " 18 l18", " 19 l19", " 20 l20",
    ]);
    expect(firstChangedLine).toBe(4);
  });

  it("双侧夹变更的上下文块 ≤ 2×contextLines 时全显不折叠", () => {
    const old = "a\nb\nc\nd\ne\nf\ng\n";
    const now = old.replace("b", "B").replace("f", "F");
    const lines = generateDiffString(old, now).diff.split("\n");
    expect(lines).toEqual([" 1 a", "-2 b", "+2 B", " 3 c", " 4 d", " 5 e", "-6 f", "+6 F", " 7 g"]);
  });
});
