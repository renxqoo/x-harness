import type { ContentBlock, SessionEvent, SessionId, SurfaceNode } from "@x-harness/session";
import { estimateContextTokens, estimateText } from "@x-harness/token-meter";
import { IMAGE_TOKENS } from "./estimate.ts";

export interface Occupancy {
  readonly tokens: number;
  readonly hasAnchor: boolean;
  readonly anchorSeq: number | undefined;
  readonly trailingTokens: number;
  readonly anchorTokens: number;
}

export function compactionBaselineSeq(events: readonly SessionEvent[]): number {
  let baseline = -1;
  for (const event of events) {
    if (event.type !== "user/message") continue;
    const op = event.surfaceOp;
    if (typeof op === "object" && op !== null && op.op === "replace") baseline = event.seq;
  }
  return baseline;
}

function anchorInput(usage: unknown): number | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const input = (usage as { input?: unknown }).input;
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) return undefined;
  return input;
}

export function measureContext(
  events: readonly SessionEvent[],
  nodes: readonly SurfaceNode[],
  opts: { readonly anchorFloor?: number; readonly trailingFactor?: number } = {},
): Occupancy {
  const baseline = Math.max(compactionBaselineSeq(events), opts.anchorFloor ?? -1);
  let anchorSeq = -1;
  let anchorTokens = 0;
  for (let i = events.length - 1; i > baseline; i -= 1) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.type !== "assistant/message" && event.type !== "assistant/attempt") continue;
    const input = anchorInput((event.data as { usage?: unknown }).usage);
    if (input === undefined) continue;
    anchorSeq = event.seq;
    anchorTokens = input;
    break;
  }
  const factor = opts.trailingFactor ?? 1;
  if (anchorSeq < 0) {
    const total = estimateContextTokens(nodes);
    return { tokens: total, hasAnchor: false, anchorSeq: undefined, trailingTokens: total, anchorTokens: 0 };
  }
  const trailingNodes: SurfaceNode[] = [];
  for (const node of nodes) {
    if (node.seq > anchorSeq) trailingNodes.push(node);
  }
  const trailing = estimateContextTokens(trailingNodes);
  void factor;
  return { tokens: anchorTokens + trailing, hasAnchor: true, anchorSeq, trailingTokens: trailing, anchorTokens };
}

export function shouldCompact(contextTokens: number, contextWindow: number, triggerPct: number): boolean {
  return contextTokens > (contextWindow * triggerPct) / 100;
}

export function lastWindow(events: readonly SessionEvent[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined || event.type !== "request/context") continue;
    const window = event.data.contextWindow;
    return typeof window === "number" && Number.isFinite(window) && window > 0 ? window : undefined;
  }
  return undefined;
}

export function lastRoute(events: readonly SessionEvent[]): { readonly provider: string; readonly model: string } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.type === "request/context") return { provider: event.data.provider, model: event.data.model };
    if (event.type === "request/header") {
      if (event.data.provider === undefined) return undefined;
      return { provider: event.data.provider, model: event.data.model };
    }
  }
  return undefined;
}

function pendingClaimIds(events: readonly SessionEvent[]): Set<string> {
  let lastUserIndex = -1;
  const ids = new Set<string>();
  for (const [i, event] of events.entries()) {
    if (event.type === "agent/inbox/spliced") {
      const data = event.data;
      if (data.op === "claim" && i > lastUserIndex) {
        for (const id of data.claimed) ids.add(id);
      } else if (data.op === "clear") {
        ids.clear();
      }
    } else if (event.type === "user/message") {
      lastUserIndex = i;
      ids.clear();
    }
  }
  return ids;
}

export function pendingClaimTokens(events: readonly SessionEvent[]): number {
  const ids = pendingClaimIds(events);
  if (ids.size === 0) return 0;
  const contentById = new Map<string, readonly ContentBlock[]>();
  for (const event of events) {
    if (event.type !== "agent/inbox/spliced" || event.data.op !== "insert") continue;
    for (const entry of event.data.entries) contentById.set(entry.id, entry.content);
  }
  let tokens = 0;
  for (const id of ids) {
    const content = contentById.get(id);
    if (content === undefined) continue;
    for (const block of content) {
      if (block.type === "text") tokens += estimateText(block.text);
      else if (block.type === "image") tokens += IMAGE_TOKENS;
    }
  }
  return tokens;
}

export type { SessionId };
