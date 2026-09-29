import { describe, expect, it } from "vitest";
import { CHUNK_SEGMENT_BYTES, ChunkReassemblerPool, chunkFrame, type ChunkSegment } from "../chunk.ts";
import type { Frame } from "../frames.ts";

function bigFrame(bytes: number): Frame {
  return { kind: "event", streamId: "ev:t1", seq: 7, body: { threadId: "t1", name: "get_messages/chunk", payload: { blob: "x".repeat(bytes) } } };
}

describe("chunkFrame 切片", () => {
  it("小帧 null；大帧切段数正确且可重组还原", () => {
    expect(chunkFrame({ kind: "ack", streamId: "a", seq: 1, body: {} })).toBeNull();
    const frame = bigFrame(CHUNK_SEGMENT_BYTES + 1000);
    const segs = chunkFrame(frame);
    expect(segs).not.toBeNull();
    expect(segs!.length).toBe(2);
    const pool = new ChunkReassemblerPool();
    let whole: string | null = null;
    for (const seg of segs!) whole = pool.add(seg) ?? whole;
    expect(whole).not.toBeNull();
    expect(JSON.parse(whole!) as Frame).toEqual(frame);
  });

  it("多段（3 段）边界", () => {
    const frame = bigFrame(CHUNK_SEGMENT_BYTES * 2 + 10);
    const segs = chunkFrame(frame)!;
    expect(segs.length).toBe(3);
    const pool = new ChunkReassemblerPool();
    let whole: string | null = null;
    for (const seg of segs) whole = pool.add(seg) ?? whole;
    expect(JSON.parse(whole!) as Frame).toEqual(frame);
  });
});

describe("ChunkReassemblerPool", () => {
  it("乱序到达可重组；重复段幂等", () => {
    const frame = bigFrame(CHUNK_SEGMENT_BYTES + 5);
    const segs = chunkFrame(frame)!;
    const pool = new ChunkReassemblerPool();
    expect(pool.add(segs[1]!)).toBeNull();
    expect(pool.add(segs[1]!)).toBeNull();
    expect(pool.size()).toBe(1);
    const whole = pool.add(segs[0]!);
    expect(whole).not.toBeNull();
    expect(pool.size()).toBe(0);
    expect(JSON.parse(whole!) as Frame).toEqual(frame);
  });

  it("segmentId 越界违约丢弃；段数声明不一致重置", () => {
    const pool = new ChunkReassemblerPool();
    const bad: ChunkSegment = { streamId: "s", seq: 1, segmentId: 5, segmentCount: 2, data: "eA==" };
    expect(pool.add(bad)).toBeNull();
    const a: ChunkSegment = { streamId: "s2", seq: 1, segmentId: 0, segmentCount: 2, data: "eA==" };
    pool.add(a);
    const conflicting: ChunkSegment = { streamId: "s2", seq: 1, segmentId: 0, segmentCount: 3, data: "eA==" };
    expect(pool.add(conflicting)).toBeNull();
  });
});
