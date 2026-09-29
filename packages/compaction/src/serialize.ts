import { isAgentDirective } from "@x-harness/session";
import type { SurfaceNode } from "@x-harness/session";

const TOOL_RESULT_MAX_CHARS = 2_000;
const TOOL_INPUT_MAX_CHARS = 2_000;

export const ROLE_LINE_PREFIXES = [
  "[System]",
  "[User]",
  "[User tool calls]",
  "[Assistant]",
  "[Assistant tool calls]",
  "[Tool result]",
] as const;

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

export function neutralizeForSummary(text: string): string {
  return text
    .replaceAll("</", "<\\/")
    .replace(OPEN_TAG_RE, "＜$1＞")
    .split(LINE_SPLIT_RE)
    .map((line) => line.replace(ROLE_LINE_RE, " $1"))
    .join("\n");
}

export function neutralizeLineStarts(text: string): string {
  return text
    .split(LINE_SPLIT_RE)
    .map((line) => line.replace(ROLE_LINE_RE, " $1"))
    .join("\n");
}

export function capSerializedConversation(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  let room = Math.max(0, maxChars - 32);
  for (let pass = 0; pass < 2; pass += 1) {
    const removed = text.length - room;
    room = Math.max(0, maxChars - `[... ${removed} characters truncated]`.length - 2);
  }
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
    else if (record["type"] === "image") {
      const mediaType = typeof record["mediaType"] === "string" ? record["mediaType"] : "unknown";
      parts.push(`[image: ${mediaType}]`);
    }
  }
  return parts.join("\n");
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
  return [`[Tool result]: ${neutralizeForSummary(truncateForSummary(text, TOOL_RESULT_MAX_CHARS - 300))}`];
}

function agentMessagePart(node: SurfaceNode): string[] {
  if (isAgentDirective(node.event)) return [];
  const texts: string[] = [];
  for (const block of contentOf(node.event.data as Record<string, unknown>)) {
    const record = block as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string") texts.push(record["text"]);
  }
  return texts.length > 0 ? [`[Agent message]: ${neutralizeForSummary(texts.join("\n"))}`] : [];
}

function partOf(node: SurfaceNode): string[] {
  const data = node.event.data as Record<string, unknown>;
  switch (node.event.type) {
    case "system/message":
      return systemPart(data);
    case "user/message":
      return userPart(contentOf(data));
    case "assistant/message":
      return assistantPart(contentOf(data));
    case "tool/result":
      return toolResultPart(data);
    case "agent/message":
      return agentMessagePart(node);
  }
}

export function serializeConversation(nodes: readonly SurfaceNode[]): string {
  const parts: string[] = [];
  for (const node of nodes) parts.push(...partOf(node));
  return parts.join("\n\n");
}
