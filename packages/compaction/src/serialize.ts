// 摘要面的序列化与注入中和（docs/COMPACTION.md §1.1）：投影节点 → 摘要提示词的
// 纯文本形态（块角色化标注——摘要模型看得见工具脉络；单工具结果/入参截断防单条
// 大输出淹没对话）；内容进提示词数据区前过三防线中和。

import { stripSummarySection } from "./section.ts";
import type { SurfaceNode } from "@x-harness/session";

const TOOL_RESULT_MAX_CHARS = 2_000;
const TOOL_INPUT_MAX_CHARS = 2_000;

/** 行首角色标签（序列化器产出形，单一来源与 serializeConversation 的产出标签一致）：
 *  内容行不得与真实轮次行首同形（伪造轮次→持久化投毒面） */
export const ROLE_LINE_PREFIXES = [
  "[System]",
  "[User]",
  "[User tool calls]",
  "[Assistant]",
  "[Assistant tool calls]",
  "[Tool result]",
] as const;

/** 中和名单单一来源：已知包裹标签的开标签全角化（conversation/previous-summary 与
 *  autocompact 账本回嵌共用）——伪造区块起点与真实包裹标签不再同形 */
export const NEUTRALIZE_OPEN_TAGS = [
  "conversation",
  "previous-summary",
  "ledger",
  "new-segment",
  "goals",
  "decisions",
  "done",
  "pending",
  "verified",
  "unverified",
  "current",
  "files",
  "read-files",
  "modified-files",
] as const;

const escapeRe = (text: string): string => text.replace(/[[\]]/g, "\\$&");
const ROLE_LINE_RE = new RegExp(`^(${[...ROLE_LINE_PREFIXES].map(escapeRe).join("|")}:)`);
const OPEN_TAG_RE = new RegExp(`<(${[...NEUTRALIZE_OPEN_TAGS].join("|")})>`, "g");
const LINE_SPLIT_RE = /\n|\r|\u2028|\u2029/;

/** 摘要面注入中和三防线：① `</` → `<\/`（字面闭合标签不可再关闭任何包裹标签）；
 *  ② 已知包裹标签的开标签转全角形；③ 行首角色标签前插空格（行边界含 U+2028/2029——
 *  部分渲染/分词面视为换行，防借其视觉换行伪造行首）。会话原文、previous-summary、
 *  autocompact 账本回嵌同一函数——二阶逃逸与一阶同源同修 */
export function neutralizeForSummary(text: string): string {
  return text
    .replaceAll("</", "<\\/")
    .replace(OPEN_TAG_RE, "＜$1＞")
    .split(LINE_SPLIT_RE)
    .map((line) => line.replace(ROLE_LINE_RE, " $1"))
    .join("\n");
}

/** 仅行首角色破坏（幂等）：截头可切掉中和加的前导空格——截断后对结果再跑一遍
 *  行首破坏封住复活面 */
export function neutralizeLineStarts(text: string): string {
  return text
    .split(LINE_SPLIT_RE)
    .map((line) => line.replace(ROLE_LINE_RE, " $1"))
    .join("\n");
}

/** 摘要输入整体上界：超界截头留尾（近端上下文对续作优先，远端内容经 previous-summary
 *  累积更新携带）。总长恒 ≤ maxChars；标注长度依赖截除量、截除量又依赖标注长度——
 *  两遍收敛。maxChars ≤ 0 → 空串（调用方降级软失败） */
export function capSerializedConversation(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  let room = Math.max(0, maxChars - 32);
  for (let pass = 0; pass < 2; pass += 1) {
    const removed = text.length - room;
    room = Math.max(0, maxChars - `[... ${removed} characters truncated]`.length - 2);
  }
  // 上界连标注+分隔都放不下：纯截尾保界（不标注，上界是硬契约）
  if (room <= 0) return text.slice(text.length - maxChars);
  const removed = text.length - room;
  return `[... ${removed} characters truncated]\n\n${text.slice(text.length - room)}`;
}

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

function textBlocksOf(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string") parts.push(record["text"]);
  }
  return parts.join("\n"); // raw——中和由调用点在截断后做（转义膨胀不撑破截断上界）
}

function callsOf(content: readonly unknown[]): string[] {
  const calls: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] !== "tool_use") continue;
    const name = typeof record["name"] === "string" ? record["name"] : "?";
    const input = typeof record["input"] === "string" ? record["input"] : "";
    calls.push(`${name}(${neutralizeForSummary(truncateForSummary(input, TOOL_INPUT_MAX_CHARS))})`);
  }
  return calls;
}

function contentOf(data: Record<string, unknown>): readonly unknown[] {
  return Array.isArray(data["content"]) ? (data["content"] as readonly unknown[]) : [];
}

function systemPart(data: Record<string, unknown>): string[] {
  const text = typeof data["text"] === "string" ? data["text"] : "";
  return text === "" ? [] : [`[System]: ${neutralizeForSummary(text)}`];
}

function userPart(content: readonly unknown[]): string[] {
  const text = textBlocksOf(content);
  const calls = callsOf(content);
  const parts: string[] = [];
  if (text !== "") parts.push(`[User]: ${neutralizeForSummary(text)}`);
  if (calls.length > 0) parts.push(`[User tool calls]: ${calls.join("; ")}`);
  return parts;
}

/** replace 型 user/message = 压缩摘要/账本节点：其文本渲染前剥离注入段（三输入面之三——
 *  docs/COMPACTION.md §15.1；L2 账本无锚点 no-op） */
function summaryNodePart(event: { readonly surfaceOp?: unknown }, content: readonly unknown[]): string[] {
  const op = event.surfaceOp;
  if (typeof op !== "object" || op === null) return userPart(content);
  return userPartStripped(content);
}

function userPartStripped(content: readonly unknown[]): string[] {
  const parts = userPart(content);
  return parts.map((part) => (part.startsWith("[User]: ") ? `[User]: ${stripSummarySection(part.slice("[User]: ".length))}` : part));
}

function assistantPart(content: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string") texts.push(record["text"]);
  }
  const calls = callsOf(content);
  const parts: string[] = [];
  if (texts.length > 0) parts.push(`[Assistant]: ${neutralizeForSummary(texts.join("\n"))}`);
  if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
  return parts;
}

function toolResultPart(data: Record<string, unknown>): string[] {
  const text = typeof data["content"] === "string" ? data["content"] : "";
  // 300 headroom：转义膨胀（</→<\/ 每处 +1）不撑破截断上界
  return [`[Tool result]: ${neutralizeForSummary(truncateForSummary(text, TOOL_RESULT_MAX_CHARS - 300))}`];
}

/** 单节点 → 提示词行（块角色化标注；内容一律过 neutralizeForSummary——数据区标签
 *  不可关闭、角色行首不可伪造；tool_use 入参与 tool 结果截断带标注） */
function partOf(node: SurfaceNode): string[] {
  const data = node.event.data as Record<string, unknown>;
  switch (node.event.type) {
    case "system/message":
      return systemPart(data);
    case "user/message":
      return summaryNodePart(node.event, contentOf(data));
    case "assistant/message":
      return assistantPart(contentOf(data));
    case "tool/result":
      return toolResultPart(data);
  }
}

/** 投影节点 → 摘要提示词的对话文本 */
export function serializeConversation(nodes: readonly SurfaceNode[]): string {
  const parts: string[] = [];
  for (const node of nodes) parts.push(...partOf(node));
  return parts.join("\n\n");
}
