// surface 投影：日志的纯函数派生。append 入尾；replace 摘除数值区间内节点、
// 新节点落在 startSeq 原位置（docs/SESSION.md §1.4）。日志永不改写。

import type { SessionEvent, SurfaceEventType, SurfaceMessage, SurfaceNode, SurfaceOp } from "./types.ts";

const SURFACE_TYPES: ReadonlySet<string> = new Set<string>([
  "system/message",
  "user/message",
  "assistant/message",
  "tool/result",
]);

export function isSurfaceEventType(type: string): type is SurfaceEventType {
  return SURFACE_TYPES.has(type);
}

export function surfaceAppend(nodes: readonly SurfaceNode[], event: SessionEvent<SurfaceEventType>): SurfaceNode[] {
  return [...nodes, { seq: event.seq, event }];
}

/** 区间摘除按数值成员判定（与位置无关）；startSeq/endSeq 必须都是现存节点且 start ≤ end，否则 undefined */
export function surfaceReplace(
  nodes: readonly SurfaceNode[],
  event: SessionEvent<SurfaceEventType>,
  op: Extract<SurfaceOp, { op: "replace" }>,
): SurfaceNode[] | undefined {
  if (op.startSeq > op.endSeq) return undefined;
  let startIdx = -1;
  let hasEnd = false;
  for (const [i, node] of nodes.entries()) {
    if (node.seq === op.startSeq) startIdx = i;
    if (node.seq === op.endSeq) hasEnd = true;
  }
  if (startIdx < 0 || !hasEnd) return undefined;
  const inRange = (node: SurfaceNode): boolean => node.seq >= op.startSeq && node.seq <= op.endSeq;
  const before = nodes.slice(0, startIdx).filter((node) => !inRange(node));
  const after = nodes.slice(startIdx).filter((node) => !inRange(node));
  return [...before, { seq: event.seq, event }, ...after];
}

export function applySurfaceEvent(
  nodes: readonly SurfaceNode[],
  event: SessionEvent<SurfaceEventType>,
): SurfaceNode[] | undefined {
  return event.surfaceOp === "append" ? surfaceAppend(nodes, event) : surfaceReplace(nodes, event, event.surfaceOp);
}

/** 内部日志（经门校验）的全量投影；损坏的 replace 防御性跳过，保持投影可计算 */
export function projectSurface(events: readonly SessionEvent[]): readonly SurfaceNode[] {
  let nodes: readonly SurfaceNode[] = [];
  for (const event of events) {
    if (!isSurfaceEventType(event.type)) continue;
    const next = applySurfaceEvent(nodes, event as SessionEvent<SurfaceEventType>);
    if (next === undefined) continue;
    nodes = next;
  }
  return nodes;
}

export function surfaceToMessages(nodes: readonly SurfaceNode[]): SurfaceMessage[] {
  return nodes.map(({ event }): SurfaceMessage => {
    switch (event.type) {
      case "system/message":
        return { role: "system", text: event.data.text };
      case "user/message":
        return { role: "user", content: event.data.content };
      case "assistant/message":
        return {
          role: "assistant",
          content: event.data.content,
          ...(event.data.usage !== undefined ? { usage: event.data.usage } : {}),
          ...(event.data.stopReason !== undefined ? { stopReason: event.data.stopReason } : {}),
        };
      case "tool/result":
        return {
          role: "tool",
          callId: event.data.callId,
          content: event.data.content,
          ...(event.data.isError !== undefined ? { isError: event.data.isError } : {}),
        };
    }
  });
}
