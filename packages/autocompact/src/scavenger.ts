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

export function computeClearPlan(nodes: readonly SurfaceNode[], events: readonly SessionEvent[], config: ScavengerConfig): ClearPlan {
  const lastStart = lastTurnStartIndex(nodes);
  if (lastStart <= 0) return { entries: [], gainTokens: 0 };
  const calls = toolCallsOf(events);
  const eligible: ClearPlanEntry[] = [];
  for (let i = lastStart - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (node === undefined || node.event.type !== "tool/result") continue;
    const data = node.event.data;
    const call = calls.get(data.callId);
    if (call === undefined || !config.clearableTools.includes(call.name)) continue;
    if (data.content.startsWith(PLACEHOLDER_PREFIX)) continue;
    if (data.content === "") continue;
    const tokens = estimateText(data.content);
    eligible.push({
      seq: node.seq,
      callId: data.callId,
      toolName: call.name,
      placeholder: `[cleared: ${call.name} ${extractPath(call.name, call.arguments)} ${String(data.content.length)} chars]`,
      originalTokens: tokens,
    });
  }
  const entries = eligible.slice(config.clearKeepRecent);
  return { entries, gainTokens: gainTokensOf(entries) };
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
