// L2 账本：已收编段的 token 记账（预算裁剪 + 文件文本计入
// + 覆写 current——整段式摘要的死穴是重述衰减（摘要的摘要），账本用机械合并消灭
// 它：goals/decisions 行级只增不删（翻案走新增行）、done 吸收 pending、verified 吸收
// unverified、current 唯一允许覆写（patch 空则保留旧值）。files 节是纯机械面，组装期
// 拼接。序列化块序 = 缓存友好（稳定前缀在前、覆写节在尾）。patch 解析失败 →
// undefined（调用方计败——切口不推进，下段更大重发；连续 3 败熔断）。

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

/** 行级 append-only 并集（旧序保持 + 新行去重追加——不删除是账本的反衰减根基） */
function unionAppend(oldLines: readonly string[], newLines: readonly string[]): string[] {
  const merged = [...oldLines];
  for (const line of newLines) {
    if (!merged.includes(line)) merged.push(line);
  }
  return merged;
}

/** 节内词表：七节标签名（杂散标签行过滤面——模型输出漏闭标签时，非贪婪
 *  解析会把后续节的开标签当内容行收进当前节，污染行会被 append-only 永久保留） */
const LEDGER_TAGS: readonly string[] = ["goals", "decisions", "done", "pending", "verified", "unverified", "current"];

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

/** 模型输出 → 账本 patch：七节标签提取；全部缺节（垃圾输出）→ undefined。
 *  current 允许多行（原文保留），其余节按行解析。 */
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

/** 机械合并：goals/decisions 行级 append-only；done 并集吸收 pending（完成即出队）；
 *  verified 并集吸收 unverified（验证后归档）；current 覆写（patch 空则保留——模型
 *  漏一节不丢「进行中工作」） */
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

/** 序列化（缓存友好块序）：稳定前缀（goals→decisions→done→pending→verified→
 *  unverified）在前，机械 files 与覆写 current 在尾——连续检查点间前缀命中缓存 */
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

/** 提示词侧序列化：节壳保持字面半角（CP 提示词要求 exact tags——整体中和会把
 *  结构标签全角化，模型镜像全角形则解析必败），内容行逐行过 neutralizeForSummary
 *  （行内毒串仍被封）。落盘快照用 serializeLedger（原文），两轨分离 */
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

/** 账本 token 量（files 文本与 current 直读计入） */
export function ledgerTokens(ledger: Ledger, filesText?: string): number {
  return estimateText(serializeLedger(ledger, filesText));
}

/** 预算裁剪（超限顺序：最旧 done → 最旧 verified；goals/decisions/pending/current
 *  永不裁——append-only 核心价值与在飞工作不可丢；只剩不可裁节时接受超限） */
export function trimLedger(ledger: Ledger, budgetTokens: number, filesText?: string): Ledger {
  let trimmed: Ledger = { ...ledger, tasksDone: [...ledger.tasksDone], factsVerified: [...ledger.factsVerified] };
  while (ledgerTokens(trimmed, filesText) > budgetTokens) {
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
  return trimmed;
}

/** 账本是否有可承载 L2 的内容 */
export function ledgerReady(ledger: Ledger): boolean {
  return (
    ledger.goals.length + ledger.decisions.length + ledger.tasksDone.length + ledger.tasksPending.length + ledger.factsVerified.length +
      ledger.factsUnverified.length >
      0 || ledger.current !== ""
  );
}
