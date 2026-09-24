// 占用测量（docs/COMPACTION.md §1.4）：journal 域扫锚（baseline/usage 锚），投影域
// 估尾（锚 seq 之后的 surface 节点）。真实计量为主、尾部估算补齐；被替换区的旧锚
// 作废（幽灵 token 防线——压缩后一次 LLM 失败不产生虚构占用）。

import type { ContentBlock, SessionEvent, SessionId, SurfaceNode } from "@x-harness/session";
import { estimateText } from "@x-harness/token-meter";
import { IMAGE_TOKENS, nodeTokens } from "./estimate.ts";

export interface Occupancy {
  readonly tokens: number;
  readonly hasAnchor: boolean;
  readonly anchorSeq: number | undefined;
  readonly trailingTokens: number;
  /** 纯锚 token（LLM 实报 usage.input——校准配对的分子；不含 trailing×factor 污染） */
  readonly anchorTokens: number;
}

/** 压缩基线：末个 replace 型 user/message 事件的 seq（compaction 摘要与 autocompact
 *  L2 账本落账都算——累积链跨层连续）；无 → -1 */
export function compactionBaselineSeq(events: readonly SessionEvent[]): number {
  let baseline = -1;
  for (const event of events) {
    if (event.type !== "user/message") continue;
    const op = event.surfaceOp;
    if (typeof op === "object" && op !== null && op.op === "replace") baseline = event.seq;
  }
  return baseline;
}

/** usage 锚的有效性：input 为有限数且 > 0（0 计量与垃圾一样不可作锚） */
function anchorInput(usage: unknown): number | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const input = (usage as { input?: unknown }).input;
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) return undefined;
  return input;
}

/** 占用测量。锚 = 基线（与 anchorFloor 取大）之后最新的 assistant/message 或
 *  assistant/attempt 且 usage.input 有效者——失败尝试的 input 度量的是同一投影的
 *  已发请求，纳入（docs/COMPACTION.md §1.4 有意分歧落档）。无锚 → 当前投影全量纯估
 *  （比参照系「从基线事件起估」更准：投影即模型可见面，替换区天然不在内）。
 *  trailingFactor 供 autocompact 校准因子接入（缺省 1）。 */
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
    let total = 0;
    for (const node of nodes) total += nodeTokens(node);
    return { tokens: total, hasAnchor: false, anchorSeq: undefined, trailingTokens: total, anchorTokens: 0 };
  }
  let trailing = 0;
  for (const node of nodes) {
    if (node.seq > anchorSeq) trailing += nodeTokens(node);
  }
  return { tokens: anchorTokens + Math.ceil(trailing * factor), hasAnchor: true, anchorSeq, trailingTokens: trailing, anchorTokens };
}

/** 触发判定：tokens > contextWindow − reserve（严格大于——reserve 是绝对预留非百分比） */
export function shouldCompact(contextTokens: number, contextWindow: number, reserveTokens: number): boolean {
  return contextTokens > contextWindow - reserveTokens;
}

/** 末个 request/context 的 contextWindow（servedWindow 读侧）：末词条定当前线路事实，
 *  缺席/垃圾 → undefined（不回看更早词条——那是别的线路纪元） */
export function lastWindow(events: readonly SessionEvent[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined || event.type !== "request/context") continue;
    const window = event.data.contextWindow;
    return typeof window === "number" && Number.isFinite(window) && window > 0 ? window : undefined;
  }
  return undefined;
}

/** 末条线路（provider+model 齐备才可写 request/context）：request/context 优先，
 *  否则 request/header（provider 缺席 → undefined，不伪造线路） */
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

/** 末条 user/message 之后未消费的 claim id 集（repair.trailingClaims 同款谓词：非消费
 *  事件——drop/retarget/clear/meta——交错不重置；clear 与新 user/message 撤销其后资格）。 */
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

/** 领取未落账批次估算：pre-step 时 beginStep 已把 claim 落为日志事件——按「末条
 *  user/message 之后的全部 claim」（agent-loop repair.trailingClaims 同款谓词：对
 *  drop/retarget/clear/meta 等非消费事件交错免疫）回查 insert 事件还原本步待落 user
 *  批次文本（大粘贴不过闸直冲 413 的防线）。同 id 多次 insert 取末次（repair 回灌后
 *  重领的现行内容） */
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
      else if (block.type === "image") tokens += IMAGE_TOKENS; // 413 防线对图不盲（与 estimateBlocks 同源常量）
    }
  }
  return tokens;
}

export type { SessionId };
