// L2 出站流：outbox 保留语义（命令条目保留至 response 认领；事件条目保留至 ACK 水位）。
import type { Frame, FrameKind } from "./frames.ts";
import { REPLAY_BUFFER_MAX } from "./limits.ts";

export interface OutboxEntry {
  frame: Frame;
  /** command 流：hostId 认领键（response 到达释放）；event 流：null（ACK 水位释放） */
  claimKey: string | null;
  sentAt: number;
  acked: boolean;
}

export class OutboxStream {
  private readonly entries: OutboxEntry[] = [];
  private nextSeq = 1;
  private lastAcked = 0;

  constructor(readonly streamId: string) {}

  /** 分配下一 seq 并入箱 */
  enqueue(body: unknown, kind: FrameKind, claimKey: string | null): { seq: number; frame: Frame } {
    const seq = this.nextSeq++;
    const frame: Frame = { kind, streamId: this.streamId, seq, body };
    this.entries.push({ frame, claimKey, sentAt: 0, acked: false });
    return { seq, frame };
  }

  /** 历史重放缓冲上限判定（command 条目在 response 认领时移出 entries，见 releaseClaim） */
  replayWindowExceeded(): boolean {
    return this.entries.length > REPLAY_BUFFER_MAX;
  }

  /** 未 ACK 事件帧重放集（cursor 续传 §1.2；只送 event/ui 类） */
  replayFrom(since: number): Frame[] {
    return this.entries.filter((e) => !e.acked && e.frame.seq > since).map((e) => e.frame);
  }

  /** 硬上限收缩（无 ACK 消费者兜底——丢最旧保连接；C3） */
  compactOldest(keep: number): void {
    while (this.entries.length > keep) this.entries.shift();
  }

  /** ACK 水位推进：释放已确认事件条目 */
  applyAck(upTo: number): number {
    let released = 0;
    this.lastAcked = Math.max(this.lastAcked, upTo);
    while (this.entries.length > 0 && this.entries[0]!.frame.seq <= upTo && this.entries[0]!.claimKey === null) {
      this.entries.shift();
      released++;
    }
    return released;
  }

  /** response 认领：命令条目释放（保留至 response 到达——§1.2） */
  releaseClaim(claimKey: string): boolean {
    const idx = this.entries.findIndex((e) => e.claimKey !== null && e.claimKey === claimKey);
    if (idx < 0) return false;
    this.entries.splice(idx, 1);
    return true;
  }

  lastAckedSeq(): number {
    return this.lastAcked;
  }

  nextSeqPeek(): number {
    return this.nextSeq;
  }

  pending(): readonly OutboxEntry[] {
    return this.entries;
  }
}
