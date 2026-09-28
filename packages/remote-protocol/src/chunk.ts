// L2 chunk 传输（DESIGN §1.2/§3.5）：大明文帧切片为多信封段（每段独立 seal+nonce，
// 段序号 segmentId/segmentCount），接收端按 (streamId, seq) 重组出完整逻辑帧。
// 段尺寸取 OUTBOUND_PAYLOAD_MAX 的一半——留 base64 膨胀余量（§3.5 尺寸预算）。
import type { Frame } from "./frames.ts";

export interface ChunkSegment {
  /** 逻辑帧定位（重组键） */
  streamId: string;
  seq: number;
  segmentId: number;
  segmentCount: number;
  /** 本段明文（帧 JSON 的 utf-8 切片，base64 编码后上线） */
  data: string;
}

export const CHUNK_SEGMENT_BYTES = 6 * 1024 * 1024; // 明文段上限（密文+base64 后 <12MiB 线上预算）

/** 切片：小于阈值返回 null（单帧直发） */
export function chunkFrame(frame: Frame, threshold = CHUNK_SEGMENT_BYTES): ChunkSegment[] | null {
  const json = JSON.stringify(frame);
  const bytes = Buffer.from(json, "utf8");
  if (bytes.length <= threshold) return null;
  const segmentCount = Math.ceil(bytes.length / threshold);
  const segments: ChunkSegment[] = [];
  for (let i = 0; i < segmentCount; i++) {
    segments.push({
      streamId: frame.streamId,
      seq: frame.seq,
      segmentId: i,
      segmentCount,
      data: Buffer.from(bytes.subarray(i * threshold, (i + 1) * threshold)).toString("base64"),
    });
  }
  return segments;
}

/** 重组器池：per (streamId, seq) 聚段，集齐还原逻辑帧 JSON */
export class ChunkReassemblerPool {
  private readonly pending = new Map<string, string[]>();

  add(segment: ChunkSegment): string | null {
    if (segment.segmentId >= segment.segmentCount) return null;
    const key = `${segment.streamId}#${segment.seq}`;
    const slots = this.pending.get(key) ?? Array.from({ length: segment.segmentCount }, () => "");
    if (slots.length !== segment.segmentCount) {
      // 段数不一致（发送方违约）——重置按本段声明
      this.pending.delete(key);
      return null;
    }
    if (slots[segment.segmentId] !== "") return null; // 重复段丢弃
    slots[segment.segmentId] = segment.data;
    if (slots.every((slot) => slot !== "")) {
      this.pending.delete(key);
      return Buffer.concat(slots.map((slot) => Buffer.from(slot, "base64"))).toString("utf8");
    }
    this.pending.set(key, slots);
    return null;
  }

  /** 未完成重组的键数（资源上界观测面） */
  size(): number {
    return this.pending.size;
  }
}
