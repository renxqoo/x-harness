// surface 投影：日志的纯函数派生。append 入尾；replace 端点以 seq 定位节点、
// 摘除两端点位置之间（含）的节点、新节点落 startSeq 端点原位置（docs/SESSION.md §1.4）。
// 日志永不改写。

import type { SessionEvent, SurfaceEventType, SurfaceMessage, SurfaceNode } from "./types.ts";

const SURFACE_TYPES: ReadonlySet<string> = new Set<string>([
  "system/message",
  "user/message",
  "assistant/message",
  "tool/result",
]);

export function isSurfaceEventType(type: string): type is SurfaceEventType {
  return SURFACE_TYPES.has(type);
}

/** 锚点下标：首个 data 含顶层 text 字段的节点（system/message 专有形态；含 dormant
 *  空文本锚）；无锚返回 -1。共用谓词——agent-loop anchorSystem 漂移替换、CLI /compact
 *  折叠区间、compaction L2 保留头三处锚定语义由此唯一决定。 */
export function anchorIndexOf(nodes: readonly SurfaceNode[]): number {
  return nodes.findIndex((node) => (node.event.data as { text?: unknown }).text !== undefined);
}

/** 投影步进的唯一真相：append 入尾；replace 端点以 seq 定位节点、摘除两端点**位置之间**
 *  （含端点）的全部节点、新节点落 startSeq 端点原位置。区间按位置不按数值成员——迭代
 *  前缀替换（压缩/滑窗）落地后头部节点携带 journal 尾 seq、其后保留节点 seq 更小，摘除集
 *  不再是数值连续区间，数值成员语义不可表达（docs/COMPACTION.md §2.A）。
 *  失败返回理由（端点缺失 / 位置逆序）——append 落账前先算步进，不可行即拒（日志零变动） */
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

/** 内部日志（落账前已过步进校验）的全量投影；损坏即抛——fail-closed，不静默算错投影 */
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
        if (event.data.text === "") return NULL_MARKER; // dormant 锚点：空文本不产消息
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
    })
    .filter((message): message is SurfaceMessage => message !== NULL_MARKER);
}
