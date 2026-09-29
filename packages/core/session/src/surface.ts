import type { SessionEvent, SurfaceEventType, SurfaceMessage, SurfaceNode } from "./types.ts";

const SURFACE_TYPES: ReadonlySet<string> = new Set<string>([
  "system/message",
  "user/message",
  "assistant/message",
  "tool/result",
  "agent/message",
]);

export function isSurfaceEventType(type: string): type is SurfaceEventType {
  return SURFACE_TYPES.has(type);
}

export function anchorIndexOf(nodes: readonly SurfaceNode[]): number {
  return nodes.findIndex((node) => (node.event.data as { text?: unknown }).text !== undefined);
}

export type SurfaceStep = { readonly ok: true; readonly nodes: SurfaceNode[] } | { readonly ok: false; readonly reason: string };

export function applySurfaceEvent(nodes: readonly SurfaceNode[], event: SessionEvent<SurfaceEventType>): SurfaceStep {
  const op = event.surfaceOp;
  if (op === "append") return { ok: true, nodes: [...nodes, { seq: event.seq, event }] };
  let startIdx = -1;
  let endIdx = -1;
  for (const [i, node] of nodes.entries()) {
    if (node.seq === op.startSeq) startIdx = i;
    if (node.seq === op.endSeq) endIdx = i;
  }
  if (startIdx < 0) return { ok: false, reason: `replace-target-missing:${op.startSeq}` };
  if (endIdx < 0) return { ok: false, reason: `replace-target-missing:${op.endSeq}` };
  if (startIdx > endIdx) return { ok: false, reason: `replace-range:${op.startSeq}>${op.endSeq}` };
  return { ok: true, nodes: [...nodes.slice(0, startIdx), { seq: event.seq, event }, ...nodes.slice(endIdx + 1)] };
}

export function projectSurface(events: readonly SessionEvent[]): readonly SurfaceNode[] {
  let nodes: readonly SurfaceNode[] = [];
  for (const event of events) {
    if (!isSurfaceEventType(event.type)) continue;
    const step = applySurfaceEvent(nodes, event as SessionEvent<SurfaceEventType>);
    if (!step.ok) throw new Error(`invalid-surface:${String(event.seq)}:${step.reason}`);
    nodes = step.nodes;
  }
  return nodes;
}

const NULL_MARKER = Symbol("dormant");
type NullMarker = typeof NULL_MARKER;

export function surfaceToMessages(nodes: readonly SurfaceNode[]): SurfaceMessage[] {
  return nodes
    .map(({ event }): SurfaceMessage | NullMarker => {
    switch (event.type) {
      case "system/message":
        if (event.data.text === "") return NULL_MARKER;
        return { role: "system", text: event.data.text };
      case "user/message":
        return { role: "user", content: event.data.content };
      case "assistant/message":
        return {
          role: "assistant",
          content: event.data.content,
          ...(event.data.usage !== undefined ? { usage: event.data.usage } : {}),
          ...(event.data.stopReason !== undefined ? { stopReason: event.data.stopReason } : {}),
          ...(event.data.thinkingBlocks !== undefined ? { thinkingBlocks: event.data.thinkingBlocks } : {}),
        };
      case "tool/result":
        return {
          role: "tool",
          callId: event.data.callId,
          content: event.data.content,
          ...(event.data.isError !== undefined ? { isError: event.data.isError } : {}),
        };
      case "agent/message":
        return { role: "user", content: event.data.content };
    }
    })
    .filter((message): message is SurfaceMessage => message !== NULL_MARKER);
}
