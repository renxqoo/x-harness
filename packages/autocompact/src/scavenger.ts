import type { Session, SessionEvent, SurfaceNode } from "@x-harness/session";
import { isTurnStartNode } from "@x-harness/compaction";
import { estimateText } from "@x-harness/token-meter";

export const PLACEHOLDER_PREFIX = "[cleared:";

export interface ClearPlanEntry {
  readonly seq: number;
  readonly callId: string;
  readonly toolName: string;
  readonly placeholder: string;
  readonly originalTokens: number;
}

export interface ClearPlan {
  readonly entries: readonly ClearPlanEntry[];
  readonly gainTokens: number;
}

export interface ScavengerConfig {
  readonly clearableTools: readonly string[];
  readonly clearKeepRecent: number;
}

function toolCallsOf(events: readonly SessionEvent[]): Map<string, { name: string; arguments: string }> {
  const byId = new Map<string, { name: string; arguments: string }>();
  for (const event of events) {
    if (event.type === "tool/call") byId.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments });
  }
  return byId;
}

function extractPath(toolName: string, rawArgs: string): string {
  let fields: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawArgs) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
  } catch {
  }
  if (typeof fields["path"] === "string" && fields["path"] !== "") return fields["path"];
  if (toolName === "bash") {
    const command = typeof fields["command"] === "string" ? fields["command"] : "";
    const head = command.split(/\s+/)[0] ?? "";
    const cwd = typeof fields["cwd"] === "string" ? fields["cwd"] : "";
    if (head !== "") return cwd !== "" ? `${head} (${cwd})` : head;
  }
  return "<no-path>";
}

export function lastTurnStartIndex(nodes: readonly SurfaceNode[]): number {
  let last = -1;
  for (const [i, node] of nodes.entries()) {
    if (isTurnStartNode(node)) last = i;
  }
  return last;
}

export function truncateDiffResult(content: string, keepLines: number, suffix: string): string {
  const lines = content.split("\n");
  if (lines.length <= keepLines) return content;
  return `${lines.slice(0, keepLines).join("\n")}\n${suffix}`;
}

export interface DiffPlanConfig {
  readonly diffTools?: readonly string[];
  readonly diffKeepLines?: number;
  readonly diffSuffix?: string;
}

interface ClearableCandidate {
  readonly isDiffTool: boolean;
  readonly entry: ClearPlanEntry;
}

function candidateOf(
  node: SurfaceNode,
  calls: Map<string, { name: string; arguments: string }>,
  config: ScavengerConfig & DiffPlanConfig,
): ClearableCandidate | undefined {
  if (node.event.type !== "tool/result") return undefined;
  const data = node.event.data;
  const call = calls.get(data.callId);
  if (call === undefined) return undefined;
  const diffTools = config.diffTools ?? [];
  const isDiffTool = diffTools.includes(call.name);
  if (!isDiffTool && !config.clearableTools.includes(call.name)) return undefined;
  if (data.content.startsWith(PLACEHOLDER_PREFIX) || data.content === "") return undefined;
  const keepLines = config.diffKeepLines ?? 0;
  if (isDiffTool && keepLines > 0 && !contentTruncated(data.content, keepLines)) return undefined;
  const tokens = estimateText(data.content);
  const replacement = isDiffTool
    ? truncateDiffResult(data.content, keepLines, config.diffSuffix ?? "")
    : `[cleared: ${call.name} ${extractPath(call.name, call.arguments)} ${String(data.content.length)} chars]`;
  const saved = isDiffTool ? tokens - estimateText(replacement) : tokens;
  return { isDiffTool, entry: { seq: node.seq, callId: data.callId, toolName: call.name, placeholder: replacement, originalTokens: saved } };
}

export function computeClearPlan(
  nodes: readonly SurfaceNode[],
  events: readonly SessionEvent[],
  config: ScavengerConfig & DiffPlanConfig,
): ClearPlan {
  const lastStart = lastTurnStartIndex(nodes);
  if (lastStart <= 0) return { entries: [], gainTokens: 0 };
  const calls = toolCallsOf(events);
  const eligible: ClearPlanEntry[] = [];
  for (let i = lastStart - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    const candidate = candidateOf(node, calls, config);
    if (candidate !== undefined) eligible.push(candidate.entry);
  }
  const entries = eligible.filter((entry) => entry.originalTokens > 0).slice(config.clearKeepRecent);
  return { entries, gainTokens: gainTokensOf(entries) };
}

function contentTruncated(content: string, keepLines: number): boolean {
  return content.split("\n").length > keepLines;
}

export function gainTokensOf(entries: readonly ClearPlanEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.originalTokens, 0);
}

export interface LandL1Result {
  readonly landed: number;
  readonly gainTokens: number;
}

export function landClearPlan(session: Session, nodes: readonly SurfaceNode[], entries: readonly ClearPlanEntry[]): LandL1Result {
  const bySeq = new Map<number, SurfaceNode>();
  for (const node of nodes) bySeq.set(node.seq, node);
  let landed = 0;
  let gainTokens = 0;
  for (const entry of entries) {
    const node = bySeq.get(entry.seq);
    if (node === undefined || node.event.type !== "tool/result") continue;
    const data = node.event.data;
    const appended = session.append(
      "tool/result",
      {
        turn: data.turn,
        step: data.step,
        callId: data.callId,
        content: entry.placeholder,
        ...(data.isError !== undefined ? { isError: data.isError } : {}),
      },
      { surfaceOp: { op: "replace", startSeq: entry.seq, endSeq: entry.seq } },
    );
    if (!appended.ok) break;
    landed += 1;
    gainTokens += entry.originalTokens;
  }
  return { landed, gainTokens };
}
