// edit 纯函数域（docs/EDIT-TOOL.md）：文本形态工具——BOM/行尾探测与保真、模糊匹配归一。
// 判别联合错误（EMPTY_OLD_TEXT/NOT_FOUND/DUPLICATE/OVERLAP/NO_CHANGE），不 throw。

/** 拆出 UTF-8 BOM：模型不会在 oldText 里带不可见 BOM，匹配前剥离、写回时还原。 */
export function splitBom(content: string): { bom: string; text: string } {
  return content.startsWith("﻿") ? { bom: "﻿", text: content.slice(1) } : { bom: "", text: content };
}

export type LineEnding = "\r\n" | "\n";

/** 行尾风格首见启发式：首个 \r\n 先于首个裸 \n 即 CRLF（与 write 契约「改完还是 CRLF」配套）。 */
export function detectLineEnding(content: string): LineEnding {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: LineEnding): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * 模糊匹配归一（模型对 Unicode 细节的典型失误面）：NFKC + 逐行 trimEnd +
 * 智能引号/破折号/特殊空格归一 ASCII。归一只发生在被触碰的行块（见
 * applyReplacementsPreservingUnchangedLines），未触行保持原始字节。
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // 智能单引号 → '
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // 智能双引号 → "
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // U+2010 连字符、U+2011 不换行连字符、U+2012 数字符、U+2013 en、U+2014 em、
      // U+2015 水平线、U+2212 减号 → -
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      // U+00A0 NBSP、U+2002-U+200A 各类空格、U+202F 窄 NBSP、U+205F 数学空格、
      // U+3000 表意空格 → 普通空格
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  );
}

export interface TextEdit {
  readonly oldText: string;
  readonly newText: string;
}

export type FindTextResult =
  | { found: true; index: number; matchLength: number; usedFuzzyMatch: boolean; contentForReplacement: string }
  | { found: false; reason: "not-found" | "empty-after-normalize" };

/**
 * 在 content 中定位 oldText：精确 indexOf 优先（命中返回原文与偏移）；失败走归一空间。
 * 归一后 oldText 为空串（NBSP/零宽类单字符）显式拒为 empty-after-normalize——
 * 与「没找到」区分，调用方映射不同文案。
 */
export function findText(content: string, oldText: string): FindTextResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false, contentForReplacement: content };
  }
  const normalizedContent = normalizeForFuzzyMatch(content);
  const normalizedOldText = normalizeForFuzzyMatch(oldText);
  if (normalizedOldText.length === 0) {
    return { found: false, reason: "empty-after-normalize" };
  }
  const normalizedIndex = normalizedContent.indexOf(normalizedOldText);
  if (normalizedIndex === -1) {
    return { found: false, reason: "not-found" };
  }
  return { found: true, index: normalizedIndex, matchLength: normalizedOldText.length, usedFuzzyMatch: true, contentForReplacement: normalizedContent };
}

interface LineSpan {
  start: number;
  end: number;
}

interface Replacement {
  matchIndex: number;
  matchLength: number;
  newText: string;
}

interface MatchedEdit extends Replacement {
  editIndex: number;
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function countOccurrences(content: string, oldText: string): number {
  return content.split(oldText).length - 1;
}

/** 逆序逐个替换：后往前应用使先前的偏移不受影响。 */
function applyReplacements(content: string, replacements: Replacement[], offset = 0): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i]!;
    const matchIndex = replacement.matchIndex - offset;
    result = result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
  }
  return result;
}

/** 求替换区间触碰的行范围 [startLine, endLine)（在 baseContent 的行 span 上）。 */
function getReplacementLineRange(lines: LineSpan[], replacement: Replacement): { startLine: number; endLine: number } {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i;
      break;
    }
  }
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine]!.end < replacementEnd) {
    endLine++;
  }
  return { startLine, endLine: endLine + 1 };
}

/**
 * 把对 baseContent（归一视图）匹配到的替换叠加回 originalContent，未触行块保持原始字节。
 * 替换按行块分组落地：归一视图里重复的行不可能被对到错的那个出现位置——
 * 对位由替换区间自身驱动，不按行文对齐。
 */
export function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: Replacement[],
): string | undefined {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    // 行数失配守卫（pi 同款 throw 的判别联合化）：归一（NFKC 拆组合字符等）使行数漂移时
    // 行块对位语义不成立——静默继续会错贴行（corrupt），显式拒走 apply 错误面
    return undefined;
  }
  const groups: Array<{ startLine: number; endLine: number; replacements: Replacement[] }> = [];
  const sorted = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  for (const replacement of sorted) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }

  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");
    const groupStartOffset = baseLines[group.startLine]!.start;
    const groupEndOffset = baseLines[group.endLine - 1]!.end;
    result += applyReplacements(baseContent.slice(groupStartOffset, groupEndOffset), group.replacements, groupStartOffset);
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join("");
  return result;
}

export type EditApplyResult =
  | { ok: true; baseContent: string; newContent: string }
  | { ok: false; reason: string };

export type CountSpace = "exact" | "normalized";

/**
 * 把一批精确文本替换应用到 LF 归一后的内容上。全部错误判别联合返回，不 throw：
 * reason 前缀为 EMPTY_OLD_TEXT / NOT_FOUND / DUPLICATE / OVERLAP / NO_CHANGE，
 * 调用方按前缀映射文案。任一 edit 失败整批拒——部分失败不产生 newContent。
 *
 * 匹配空间按批次决定：任一 edit 精确失败即整批转模糊空间（批次级基底切换）。
 * 唯一性计数跟随各自空间：精确批次按原文 LF 串数，模糊批次按归一串数
 * （精确唯一但归一多处时放行精确——不被归一计数误拒）。
 * 重叠检测在应用空间用字符串偏移：prevEnd > curStart 拒；行块分组只合并不拒绝。
 */
function emptyReason(where: string, literal: boolean): string {
  return literal
    ? `EMPTY_OLD_TEXT: oldText must not be empty (${where})`
    : `EMPTY_OLD_TEXT: ${where} normalizes to empty text (invisible characters only)`;
}

/** 字面空与归一后空两关前置检查（A 件 2：归一后空在匹配前显式拒）。 */
function checkEmptyOldText(lfEdits: Array<{ oldText: string }>, matches: FindTextResult[], where: (i: number) => string): string | undefined {
  for (let i = 0; i < lfEdits.length; i++) {
    if (lfEdits[i]!.oldText.length === 0) {
      return emptyReason(where(i), true);
    }
  }
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    if (!match.found && match.reason === "empty-after-normalize") {
      return emptyReason(where(i), false);
    }
  }
  return undefined;
}

/** 批次匹配上下文：应用基底 + 命名器 + 计数空间口径。 */
interface MatchContext {
  base: string;
  where: (i: number) => string;
  usedFuzzyMatch: boolean;
  countSpace: CountSpace;
}

/** 在 ctx.base 空间逐条匹配并做唯一性计数；任一失败返回拒因（全批拒）。 */
function matchAllEdits(
  ctx: MatchContext,
  lfEdits: Array<{ oldText: string; newText: string }>,
): { ok: true; matched: MatchedEdit[] } | { ok: false; reason: string } {
  const { base, where, usedFuzzyMatch, countSpace } = ctx;
  const matched: MatchedEdit[] = [];
  for (let i = 0; i < lfEdits.length; i++) {
    const edit = lfEdits[i]!;
    const matchResult = findText(base, edit.oldText);
    if (!matchResult.found) {
      if (matchResult.reason === "empty-after-normalize") {
        return { ok: false, reason: emptyReason(where(i), false) };
      }
      const hint = usedFuzzyMatch ? " even after normalization (quotes/dashes/whitespace)" : " exactly including all whitespace and newlines";
      return { ok: false, reason: `NOT_FOUND: could not find ${where(i)}${hint}. If the file changed since read, re-read it first.` };
    }
    // 唯一性计数跟随匹配空间：模糊批次数归一形（与命中/替换实际发生的空间一致）
    const occurrences = countOccurrences(base, usedFuzzyMatch ? normalizeForFuzzyMatch(edit.oldText) : edit.oldText);
    if (occurrences > 1) {
      return {
        ok: false,
        reason: `DUPLICATE: found ${String(occurrences)} occurrences of ${where(i)} (counted in ${countSpace} space). Provide more context to make it unique.`,
      };
    }
    matched.push({ editIndex: i, matchIndex: matchResult.index, matchLength: matchResult.matchLength, newText: edit.newText });
  }
  return { ok: true, matched };
}

/** 应用空间字符串偏移重叠检测：prevEnd > curStart 拒；相邻贴边放行。 */
function findOverlap(matched: MatchedEdit[], path: string): string | undefined {
  const sorted = [...matched].sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      return `OVERLAP: edits[${String(previous.editIndex)}] and edits[${String(current.editIndex)}] overlap in ${path}. Merge them into one edit or target disjoint regions.`;
    }
  }
  return undefined;
}

export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: readonly TextEdit[],
  path: string,
): EditApplyResult {
  const lfEdits = edits.map((edit) => ({ oldText: normalizeToLF(edit.oldText), newText: normalizeToLF(edit.newText) }));
  const where = (i: number): string => (lfEdits.length === 1 ? path : `edits[${String(i)}] in ${path}`);

  const initialMatches = lfEdits.map((edit) => findText(normalizedContent, edit.oldText));
  const empty = checkEmptyOldText(lfEdits, initialMatches, where);
  if (empty !== undefined) {
    return { ok: false, reason: empty };
  }

  const usedFuzzyMatch = initialMatches.some((match) => match.found && match.usedFuzzyMatch);
  const base = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;
  const countSpace: CountSpace = usedFuzzyMatch ? "normalized" : "exact";

  const matched = matchAllEdits({ base, where, usedFuzzyMatch, countSpace }, lfEdits);
  if (!matched.ok) {
    return { ok: false, reason: matched.reason };
  }
  const overlap = findOverlap(matched.matched, path);
  if (overlap !== undefined) {
    return { ok: false, reason: overlap };
  }

  const applied = usedFuzzyMatch
    ? applyReplacementsPreservingUnchangedLines(normalizedContent, base, matched.matched)
    : applyReplacements(base, matched.matched);
  if (applied === undefined) {
    return { ok: false, reason: `LINE_COUNT_MISMATCH: normalization changed the line count of ${path}; cannot preserve unchanged lines. Re-read the file and retry with exact oldText.` };
  }
  const newContent = applied;

  if (normalizedContent === newContent) {
    return { ok: false, reason: `NO_CHANGE: replacements produced identical content in ${path}` };
  }
  return { ok: true, baseContent: normalizedContent, newContent };
}
