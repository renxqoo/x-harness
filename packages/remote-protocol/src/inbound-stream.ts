import type { Frame } from "./frames.ts";
import { ACK_EVERY_FRAMES, ACK_INTERVAL_MS, REORDER_BUFFER_MAX } from "./limits.ts";

export type InboundOutcome =
  | { kind: "deliver"; frame: Frame }
  | { kind: "duplicate-ack"; frame: Frame }
  | { kind: "replay-rejected"; seq: number }
  | { kind: "buffered"; depth: number }
  | { kind: "gap"; expected: number; got: number };

export interface StreamCounters {
  duplicates: number;
  replays: number;
  buffered: number;
  gaps: number;
}

export class InboundStream {
  private lastDelivered = 0;
  private readonly reorder = new Map<number, Frame>();
  private counters: StreamCounters = { duplicates: 0, replays: 0, buffered: 0, gaps: 0 };
  private ackDebt = 0;

  constructor(
    readonly streamId: string,
    baseSeq?: number,
  ) {
    if (baseSeq !== undefined && baseSeq >= 0) this.lastDelivered = baseSeq;
  }

  base(): number {
    return this.lastDelivered;
  }

  accept(frame: Frame): InboundOutcome {
    if (frame.seq === this.lastDelivered) {
      this.counters.duplicates++;
      return { kind: "duplicate-ack", frame };
    }
    if (frame.seq < this.lastDelivered) {
      this.counters.replays++;
      return { kind: "replay-rejected", seq: frame.seq };
    }
    if (frame.seq === this.lastDelivered + 1) {
      this.lastDelivered++;
      this.ackDebt++;
      const outcomes: InboundOutcome[] = [{ kind: "deliver", frame }];
      while (this.reorder.has(this.lastDelivered + 1)) {
        const next = this.reorder.get(this.lastDelivered + 1)!;
        this.reorder.delete(this.lastDelivered + 1);
        this.lastDelivered++;
        this.ackDebt++;
        outcomes.push({ kind: "deliver", frame: next });
      }
      this.counters.buffered = this.reorder.size;
      return outcomes[0]!;
    }
    if (this.reorder.size >= REORDER_BUFFER_MAX) {
      this.counters.gaps++;
      return { kind: "gap", expected: this.lastDelivered + 1, got: frame.seq };
    }
    this.reorder.set(frame.seq, frame);
    this.counters.buffered = this.reorder.size;
    return { kind: "buffered", depth: this.reorder.size };
  }

  drain(): Frame | null {
    const next = this.reorder.get(this.lastDelivered + 1);
    if (!next) return null;
    this.reorder.delete(this.lastDelivered + 1);
    this.lastDelivered++;
    this.ackDebt++;
    this.counters.buffered = this.reorder.size;
    return next;
  }

  ackDue(now: number, lastAckFlush: number): boolean {
    return this.ackDebt >= ACK_EVERY_FRAMES || (this.ackDebt > 0 && now - lastAckFlush >= ACK_INTERVAL_MS);
  }

  flushAck(): { streamId: string; upTo: number } | null {
    if (this.ackDebt === 0) return null;
    this.ackDebt = 0;
    return { streamId: this.streamId, upTo: this.lastDelivered };
  }

  stats(): StreamCounters {
    return { ...this.counters, buffered: this.reorder.size };
  }
}


export interface OutboxEntry {
  frame: Frame;
  claimKey: string | null;
  sentAt: number;
  acked: boolean;
}
