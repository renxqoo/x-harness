// L2 可靠层余量：分片与解析门（DESIGN §1.2）。流状态机见 inbound-stream.ts / outbox.ts / reassemble.ts。
import { FRAME_KINDS, type ChunkBody, type Frame, type FrameKind } from "./frames.ts";
import { PLAIN_FRAME_CHUNK_THRESHOLD, REASSEMBLY_MAX_SEGMENTS } from "./limits.ts";

export type { InboundOutcome, StreamCounters } from "./inbound-stream.ts";
export { InboundStream } from "./inbound-stream.ts";
export type { OutboxEntry } from "./outbox.ts";
export { OutboxStream } from "./outbox.ts";
export type { ReassembleOutcome } from "./reassemble.ts";
export { FrameReassembler } from "./reassemble.ts";

export interface ChunkSpec {
  segmentId: number;
  segmentCount: number;
  totalBytes: number;
  data: string;
}

/** 明文帧 JSON 切片（base64 段） */
export function chunkFrame(frameJson: string, threshold = PLAIN_FRAME_CHUNK_THRESHOLD): ChunkSpec[] | null {
  const bytes = Buffer.from(frameJson, "utf8");
  if (bytes.length <= threshold) return null;
  const segmentBytes = threshold;
  const segmentCount = Math.ceil(bytes.length / segmentBytes);
  if (segmentCount > REASSEMBLY_MAX_SEGMENTS) return null;
  const specs: ChunkSpec[] = [];
  for (let i = 0; i < segmentCount; i++) {
    specs.push({
      segmentId: i,
      segmentCount,
      totalBytes: bytes.length,
      data: Buffer.from(bytes.subarray(i * segmentBytes, (i + 1) * segmentBytes)).toString("base64"),
    });
  }
  return specs;
}

/** 帧合法性门（垃圾输入降级 null，不抛） */
export function parseFrame(json: string): Frame | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const f = raw as Partial<Frame>;
  if (typeof f.kind !== "string" || !FRAME_KINDS.includes(f.kind as FrameKind)) return null;
  if (typeof f.streamId !== "string" || f.streamId.length === 0) return null;
  if (typeof f.seq !== "number" || !Number.isInteger(f.seq) || f.seq < 0) return null;
  if (f.body === undefined) return null;
  return { kind: f.kind as FrameKind, streamId: f.streamId, seq: f.seq, body: f.body };
}

/** chunk body 校验（垃圾降级 null） */
export function parseChunkBody(body: unknown): ChunkBody | null {
  if (typeof body !== "object" || body === null) return null;
  const c = body as Partial<ChunkBody>;
  if (typeof c.segmentId !== "number" || typeof c.segmentCount !== "number" || typeof c.totalBytes !== "number" || typeof c.data !== "string") return null;
  if (!Number.isInteger(c.segmentId) || !Number.isInteger(c.segmentCount) || !Number.isInteger(c.totalBytes)) return null;
  if (c.segmentId < 0 || c.segmentCount <= 0 || c.segmentId >= c.segmentCount) return null;
  if (c.totalBytes <= 0 || c.data.length === 0) return null;
  return { segmentId: c.segmentId, segmentCount: c.segmentCount, totalBytes: c.totalBytes, data: c.data };
}
