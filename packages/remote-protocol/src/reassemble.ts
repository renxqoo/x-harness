// L2 分片重组器：单逻辑帧（streamId+seq 定位；DESIGN §1.2 上限集）。
import { REASSEMBLY_MAX_BYTES, REASSEMBLY_MAX_SEGMENTS } from "./limits.ts";
import type { ChunkSpec } from "./reliable.ts";

export type ReassembleOutcome =
  | { ok: true; frameJson: string }
  | { ok: false; reason: "duplicate-segment" | "too-large" | "too-many-segments" | "pending" };

export class FrameReassembler {
  private readonly segments = new Map<number, string>();
  readonly streamId: string;
  readonly seq: number;
  readonly segmentCount: number;
  readonly totalBytes: number;
  constructor(spec: { streamId: string; seq: number; segmentCount: number; totalBytes: number }) {
    this.streamId = spec.streamId;
    this.seq = spec.seq;
    this.segmentCount = spec.segmentCount;
    this.totalBytes = spec.totalBytes;
    if (spec.segmentCount > REASSEMBLY_MAX_SEGMENTS || spec.totalBytes > REASSEMBLY_MAX_BYTES) {
      throw new Error("reassembly limits exceeded");
    }
  }

  add(spec: ChunkSpec): ReassembleOutcome {
    if (this.segments.has(spec.segmentId)) return { ok: false, reason: "duplicate-segment" };
    const decoded = Buffer.from(spec.data, "base64");
    if (this.totalBytes + decoded.length > REASSEMBLY_MAX_BYTES) return { ok: false, reason: "too-large" };
    this.segments.set(spec.segmentId, spec.data);
    if (this.segments.size === this.segmentCount) {
      const parts: Buffer[] = [];
      for (let i = 0; i < this.segmentCount; i++) {
        parts.push(Buffer.from(this.segments.get(i)!, "base64"));
      }
      return { ok: true, frameJson: Buffer.concat(parts).toString("utf8") };
    }
    return { ok: false, reason: "pending" };
  }
}
