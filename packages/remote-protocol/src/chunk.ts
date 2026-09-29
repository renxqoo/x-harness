import type { Frame } from "./frames.ts";

export interface ChunkSegment {
  streamId: string;
  seq: number;
  segmentId: number;
  segmentCount: number;
  data: string;
}

export const CHUNK_SEGMENT_BYTES = 6 * 1024 * 1024;

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

export class ChunkReassemblerPool {
  private readonly pending = new Map<string, string[]>();

  add(segment: ChunkSegment): string | null {
    if (segment.segmentId >= segment.segmentCount) return null;
    const key = `${segment.streamId}#${segment.seq}`;
    const slots = this.pending.get(key) ?? Array.from({ length: segment.segmentCount }, () => "");
    if (slots.length !== segment.segmentCount) {
      this.pending.delete(key);
      return null;
    }
    if (slots[segment.segmentId] !== "") return null;
    slots[segment.segmentId] = segment.data;
    if (slots.every((slot) => slot !== "")) {
      this.pending.delete(key);
      return Buffer.concat(slots.map((slot) => Buffer.from(slot, "base64"))).toString("utf8");
    }
    this.pending.set(key, slots);
    return null;
  }

  size(): number {
    return this.pending.size;
  }
}
