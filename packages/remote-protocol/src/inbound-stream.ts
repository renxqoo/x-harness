// L2 入站流：seq 去重/重排/ACK 合并（DESIGN §1.2）。订阅基线 + 重复补 ACK + 真重放拒收。
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
    /** 订阅基线（§1.2 hello-ack bases）：新接入/重启直接采用 */
    baseSeq?: number,
  ) {
    if (baseSeq !== undefined && baseSeq >= 0) this.lastDelivered = baseSeq;
  }

  /** 已宣告基线（发送方 hello-ack 携带） */
  base(): number {
    return this.lastDelivered;
  }

  /** 收到一帧（chunk 前的完整逻辑帧） */
  accept(frame: Frame): InboundOutcome {
    if (frame.seq === this.lastDelivered) {
      // 重复帧：ACK 丢失后的合法重发——丢弃载荷补 ACK（不重复上行）
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
      // 排空缓冲
      while (this.reorder.has(this.lastDelivered + 1)) {
        const next = this.reorder.get(this.lastDelivered + 1)!;
        this.reorder.delete(this.lastDelivered + 1);
        this.lastDelivered++;
        this.ackDebt++;
        outcomes.push({ kind: "deliver", frame: next });
      }
      this.counters.buffered = this.reorder.size;
      // 交给上层逐帧处理：本方法只回第一帧 + flush 标记
      return outcomes[0]!;
    }
    // 乱序：入重排缓冲（有界）
    if (this.reorder.size >= REORDER_BUFFER_MAX) {
      this.counters.gaps++;
      return { kind: "gap", expected: this.lastDelivered + 1, got: frame.seq };
    }
    this.reorder.set(frame.seq, frame);
    this.counters.buffered = this.reorder.size;
    return { kind: "buffered", depth: this.reorder.size };
  }

  /** 排空重排缓冲后的后续帧（accept 返回 deliver 后调用直至 drained） */
  drain(): Frame | null {
    const next = this.reorder.get(this.lastDelivered + 1);
    if (!next) return null;
    this.reorder.delete(this.lastDelivered + 1);
    this.lastDelivered++;
    this.ackDebt++;
    this.counters.buffered = this.reorder.size;
    return next;
  }

  /** ACK 合并判定：每 32 帧或计时器到点（计时器由传输层驱动 flushAck） */
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

// ---- 出站可靠层：outbox（命令条目保留至 response；事件条目保留至 ACK 水位） ----

export interface OutboxEntry {
  frame: Frame;
  /** command 流：hostId 认领键（response 到达释放）；event 流：null（ACK 水位释放） */
  claimKey: string | null;
  sentAt: number;
  acked: boolean;
}
