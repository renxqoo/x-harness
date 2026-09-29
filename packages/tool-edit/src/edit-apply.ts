export function splitBom(content: string): { bom: string; text: string } {
  return content.startsWith("﻿") ? { bom: "﻿", text: content.slice(1) } : { bom: "", text: content };
}

export type LineEnding = "\r\n" | "\n";

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

export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
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

function applyReplacements(content: string, replacements: Replacement[], offset = 0): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i]!;
    const matchIndex = replacement.matchIndex - offset;
    result = result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
  }
  return result;
}

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

export function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: Replacement[],
): string | undefined {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
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

function emptyReason(where: string, literal: boolean): string {
  return literal
    ? `EMPTY_OLD_TEXT: oldText must not be empty (${where})`
    : `EMPTY_OLD_TEXT: ${where} normalizes to empty text (invisible characters only)`;
}

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

interface MatchContext {
  base: string;
  where: (i: number) => string;
  usedFuzzyMatch: boolean;
  countSpace: CountSpace;
}

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
