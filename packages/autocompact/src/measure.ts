import type { SessionEvent, SessionId, SurfaceNode } from "@x-harness/session";
import { measureContext, pendingClaimTokens } from "@x-harness/compaction";
import type { Occupancy } from "@x-harness/compaction";

export interface L1GainEntry {
  tokens: number;
  sinceSeq: number;
}

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

export function pruneAbsorbedGains(gains: L1Gains, anchorSeq: number | undefined): void {
  if (anchorSeq === undefined) return;
  for (let i = gains.length - 1; i >= 0; i -= 1) {
    if ((gains[i] as L1GainEntry).sinceSeq <= anchorSeq) gains.splice(i, 1);
  }
}

export function pushGain(gains: L1Gains, entry: L1GainEntry): void {
  gains.push(entry);
  if (gains.length > 8) gains.shift();
}
