// 占用测量组合面（docs/COMPACTION.md §1.2/§1.4）：锚/尾估复用 compaction 的
// 测量：occupancy + gains 的组合测量面
// 特有面：并行度观测（首步增量缺省）、L1 收益扣减（锚时效规则）、领取批次。

import type { SessionEvent, SessionId, SurfaceNode } from "@x-harness/session";
import { measureContext, pendingClaimTokens } from "@x-harness/compaction";
import type { Occupancy } from "@x-harness/compaction";

/** 单次 L1 落账收益 */
export interface L1GainEntry {
  tokens: number;
  /** 落账末事件 seq */
  sinceSeq: number;
}

/** 已落账 L1 收益列表（锚时效：新锚的 usage 已含清理效果——锚 seq ≥ 落账 seq 的
 *  条目已被吸收停计；单累计对会在混合时序下重复扣减旧收益） */
export type L1Gains = L1GainEntry[];

export interface OccupancyInput {
  readonly session: SessionId;
  readonly events: readonly SessionEvent[];
  readonly nodes: readonly SurfaceNode[];
  readonly calibration: number;
  readonly gains: readonly L1GainEntry[];
}

export interface Measured {
  readonly occupancy: Occupancy & { readonly tokens: number };
  readonly gainTokens: number;
  readonly maxParallel: number;
  readonly pendingClaimTokens: number;
}

/** 尾部 assistant 消息的并行 tool_use 峰值（事件序末 12 条窗口——首步增量缺省
 *  的观测面：并行批一拳越窗风险） */
export function trailingMaxParallel(events: readonly SessionEvent[]): number {
  let max = 1;
  for (let i = events.length - 1; i >= 0 && i >= events.length - 12; i -= 1) {
    const event = events[i];
    if (event === undefined || event.type !== "assistant/message") continue;
    const uses = event.data.content.filter((block) => block.type === "tool_use").length;
    if (uses > max) max = uses;
  }
  return max;
}

/** 占用 = measureContext（校准尾估）− 未吸收 L1 收益 + 领取未落账批次。
 *  锚时效规则：只扣减 sinceSeq > 锚 seq 的落账（锚的 usage 尚未含其效果）；
 *  已吸收条目（锚 seq ≥ sinceSeq）停计——由调用方剪除。 */
export function measureOccupancy(input: OccupancyInput): Measured {
  const occupancy = measureContext(input.events, input.nodes, { trailingFactor: input.calibration });
  const anchorSeq = occupancy.anchorSeq ?? -1;
  const gainTokens = input.gains.filter((entry) => entry.sinceSeq > anchorSeq).reduce((sum, entry) => sum + entry.tokens, 0);
  const pending = pendingClaimTokens(input.events);
  return {
    occupancy,
    gainTokens,
    maxParallel: trailingMaxParallel(input.events),
    pendingClaimTokens: pending,
  };
}

/** 剪除已被锚吸收的收益条目（调用方在测量后落账新锚时执行——防列表无界增长） */
export function pruneAbsorbedGains(gains: L1Gains, anchorSeq: number | undefined): void {
  if (anchorSeq === undefined) return;
  for (let i = gains.length - 1; i >= 0; i -= 1) {
    if ((gains[i] as L1GainEntry).sinceSeq <= anchorSeq) gains.splice(i, 1);
  }
}

/** 追加一次落账收益（有界：保留最近 8 条） */
export function pushGain(gains: L1Gains, entry: L1GainEntry): void {
  gains.push(entry);
  if (gains.length > 8) gains.shift();
}
