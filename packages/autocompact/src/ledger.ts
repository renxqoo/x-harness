import { neutralizeForSummary } from "@x-harness/compaction";
import { estimateText } from "@x-harness/token-meter";

export interface Ledger {
  readonly goals: string[];
  readonly decisions: string[];
  readonly tasksDone: string[];
  readonly tasksPending: string[];
  readonly factsVerified: string[];
  readonly factsUnverified: string[];
  readonly current: string;
}

export function emptyLedger(): Ledger {
  return { goals: [], decisions: [], tasksPending: [], tasksDone: [], factsUnverified: [], factsVerified: [], current: "" };
}

function unionAppend(oldLines: readonly string[], newLines: readonly string[]): string[] {
  const merged = [...oldLines];
  for (const line of newLines) {
    if (!merged.includes(line)) merged.push(line);
  }
  return merged;
}

const LEDGER_TAGS: readonly string[] = ["goals", "decisions", "done", "pending", "verified", "unverified", "current", "files"];

function isTagLine(line: string): boolean {
  for (const tag of LEDGER_TAGS) {
    if (line === `<${tag}>` || line === `</${tag}>`) return true;
  }
  return false;
}

function sectionLines(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "(none)" && line !== "-" && !isTagLine(line));
}

function tagContent(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match?.[1];
}

export function parseLedgerPatch(text: string): Ledger | undefined {
  const goals = sectionLines(tagContent(text, "goals"));
  const decisions = sectionLines(tagContent(text, "decisions"));
  const tasksDone = sectionLines(tagContent(text, "done"));
  const tasksPending = sectionLines(tagContent(text, "pending"));
  const factsVerified = sectionLines(tagContent(text, "verified"));
  const factsUnverified = sectionLines(tagContent(text, "unverified"));
  const current = (tagContent(text, "current") ?? "").trim();
  const anySection =
    goals.length + decisions.length + tasksDone.length + tasksPending.length + factsVerified.length + factsUnverified.length > 0 || current !== "";
  if (!anySection) return undefined;
  return { goals, decisions, tasksDone, tasksPending, factsVerified, factsUnverified, current };
}

export function mergeLedger(old: Ledger, patch: Ledger): Ledger {
  const tasksDone = unionAppend(old.tasksDone, patch.tasksDone);
  const tasksPending = unionAppend(old.tasksPending, patch.tasksPending).filter((line) => !tasksDone.includes(line));
  const factsVerified = unionAppend(old.factsVerified, patch.factsVerified);
  const factsUnverified = unionAppend(old.factsUnverified, patch.factsUnverified).filter((line) => !factsVerified.includes(line));
  return {
    goals: unionAppend(old.goals, patch.goals),
    decisions: unionAppend(old.decisions, patch.decisions),
    tasksDone,
    tasksPending,
    factsVerified,
    factsUnverified,
    current: patch.current !== "" ? patch.current : old.current,
  };
}

function renderSection(tag: string, lines: readonly string[]): string {
  if (lines.length === 0) return `<${tag}>\n(none)\n</${tag}>`;
  return `<${tag}>\n${lines.join("\n")}\n</${tag}>`;
}

export function serializeLedger(ledger: Ledger, filesText?: string): string {
  const parts = [
    renderSection("goals", ledger.goals),
    renderSection("decisions", ledger.decisions),
    renderSection("done", ledger.tasksDone),
    renderSection("pending", ledger.tasksPending),
    renderSection("verified", ledger.factsVerified),
    renderSection("unverified", ledger.factsUnverified),
  ];
  if (filesText !== undefined && filesText !== "") parts.push(`<files>\n${filesText}\n</files>`);
  if (ledger.current !== "") parts.push(`<current>\n${ledger.current}\n</current>`);
  return parts.join("\n\n");
}

export function serializeLedgerForPrompt(ledger: Ledger, filesText?: string): string {
  const section = (tag: string, lines: readonly string[]): string => renderSection(tag, lines.map(neutralizeForSummary));
  const parts = [
    section("goals", ledger.goals),
    section("decisions", ledger.decisions),
    section("done", ledger.tasksDone),
    section("pending", ledger.tasksPending),
    section("verified", ledger.factsVerified),
    section("unverified", ledger.factsUnverified),
  ];
  if (filesText !== undefined && filesText !== "") parts.push(`<files>\n${neutralizeForSummary(filesText)}\n</files>`);
  if (ledger.current !== "") parts.push(`<current>\n${neutralizeForSummary(ledger.current)}\n</current>`);
  return parts.join("\n\n");
}

export function ledgerTokens(ledger: Ledger, filesText?: string): number {
  return estimateText(serializeLedger(ledger, filesText));
}

function clampFilesText(filesText: string | undefined, budgetTokens: number): string | undefined {
  if (filesText === undefined || filesText === "") return undefined;
  if (estimateText(filesText) <= budgetTokens) return filesText;
  const lines = filesText.split("\n");
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const next = [line, ...kept];
    if (estimateText(next.join("\n")) > budgetTokens && kept.length > 0) break;
    kept.unshift(line);
  }
  return kept.length > 0 ? kept.join("\n") : undefined;
}

export function trimLedgerWithFiles(
  ledger: Ledger,
  budgetTokens: number,
  filesText?: string,
): { readonly ledger: Ledger; readonly filesText: string | undefined } {
  const filesBudget = Math.floor(budgetTokens * 0.5);
  const clampedFiles = clampFilesText(filesText, filesBudget);
  let trimmed: Ledger = { ...ledger, tasksDone: [...ledger.tasksDone], factsVerified: [...ledger.factsVerified] };
  while (ledgerTokens(trimmed, clampedFiles) > budgetTokens) {
    if (trimmed.tasksDone.length > 0) {
      trimmed = { ...trimmed, tasksDone: trimmed.tasksDone.slice(1) };
      continue;
    }
    if (trimmed.factsVerified.length > 0) {
      trimmed = { ...trimmed, factsVerified: trimmed.factsVerified.slice(1) };
      continue;
    }
    break;
  }
  return { ledger: trimmed, filesText: clampedFiles };
}

export function ledgerReady(ledger: Ledger): boolean {
  return (
    ledger.goals.length + ledger.decisions.length + ledger.tasksDone.length + ledger.tasksPending.length + ledger.factsVerified.length +
      ledger.factsUnverified.length >
      0 || ledger.current !== ""
  );
}
