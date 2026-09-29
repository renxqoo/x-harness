import type { Frame, FrameKind } from "./frames.ts";
import { REPLAY_BUFFER_MAX } from "./limits.ts";

export interface OutboxEntry {
  frame: Frame;
  claimKey: string | null;
  sentAt: number;
  acked: boolean;
}

export class OutboxStream {
  private readonly entries: OutboxEntry[] = [];
  private nextSeq = 1;
  private lastAcked = 0;

  constructor(readonly streamId: string) {}

  enqueue(body: unknown, kind: FrameKind, claimKey: string | null): { seq: number; frame: Frame } {
    const seq = this.nextSeq++;
    const frame: Frame = { kind, streamId: this.streamId, seq, body };
    this.entries.push({ frame, claimKey, sentAt: 0, acked: false });
    return { seq, frame };
  }

  replayWindowExceeded(): boolean {
    return this.entries.length > REPLAY_BUFFER_MAX;
  }

  replayFrom(since: number): Frame[] {
    return this.entries.filter((e) => !e.acked && e.frame.seq > since).map((e) => e.frame);
  }

  compactOldest(keep: number): void {
    while (this.entries.length > keep) this.entries.shift();
  }

  applyAck(upTo: number): number {
    let released = 0;
    this.lastAcked = Math.max(this.lastAcked, upTo);
    while (this.entries.length > 0 && this.entries[0]!.frame.seq <= upTo && this.entries[0]!.claimKey === null) {
      this.entries.shift();
      released++;
    }
    return released;
  }

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
