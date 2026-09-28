// L2 可靠层契约：重复补 ACK/真重放拒收/乱序/gap/订阅基线/ACK 合并/outbox 保留语义/
// 分片重组——DESIGN §1.2 全锚点
import { describe, expect, it } from "vitest";
import { FrameReassembler, InboundStream, OutboxStream, chunkFrame, parseChunkBody, parseFrame } from "../reliable.ts";
import { REASSEMBLY_MAX_SEGMENTS, REORDER_BUFFER_MAX } from "../limits.ts";

function frame(seq: number, kind: "event" | "command" = "event") {
  return { kind, streamId: "st_t1", seq, body: { n: seq } };
}

describe("InboundStream seq 生命周期", () => {
  it("顺序投递；重复帧补 ACK 不上行；真重放拒收", () => {
    const s = new InboundStream("st_t1");
    expect(s.accept(frame(1))).toMatchObject({ kind: "deliver" });
    expect(s.accept(frame(2))).toMatchObject({ kind: "deliver" });
    // 重复（ACK 丢失重发）
    expect(s.accept(frame(2))).toMatchObject({ kind: "duplicate-ack" });
    expect(s.accept(frame(1))).toMatchObject({ kind: "replay-rejected", seq: 1 });
    expect(s.stats().duplicates).toBe(1);
    expect(s.stats().replays).toBe(1);
  });

  it("乱序入重排缓冲，补帧后连投（accept 内排空）", () => {
    const s = new InboundStream("st_t1");
    expect(s.accept(frame(1))).toMatchObject({ kind: "deliver" });
    expect(s.accept(frame(3))).toMatchObject({ kind: "buffered" });
    expect(s.accept(frame(4))).toMatchObject({ kind: "buffered" });
    // 补帧 2：accept 内连投 2、3、4（缓冲全部排空）
    expect(s.accept(frame(2))).toMatchObject({ kind: "deliver", frame: { seq: 2 } });
    expect(s.drain()).toBeNull();
    expect(s.base()).toBe(4);
  });

  it("重排缓冲溢出 → gap（expect/got 字段）；drain 排空；gap 计数", () => {
    const s = new InboundStream("st_t1");
    s.accept(frame(1));
    for (let i = 3; i < 3 + REORDER_BUFFER_MAX; i++) {
      const out = s.accept(frame(i));
      if (i < REORDER_BUFFER_MAX + 2) expect(out.kind).toBe("buffered");
    }
    const overflow = s.accept(frame(REORDER_BUFFER_MAX + 4));
    expect(overflow.kind).toBe("gap");
    if (overflow.kind === "gap") {
      expect(overflow.expected).toBe(2);
      expect(overflow.got).toBe(REORDER_BUFFER_MAX + 4);
    }
    expect(s.stats().gaps).toBeGreaterThanOrEqual(1);
    // gap 后重排缓冲仍持有乱序帧：补 2 → accept 内排空（deliver 返回首帧，其余经 drain）
    const deliver = s.accept(frame(2));
    expect(deliver.kind).toBe("deliver");
    let drained = 0;
    while (s.drain() !== null) drained += 1;
    expect(s.base()).toBe(REORDER_BUFFER_MAX + 2); // 2..1026 全部按序送达（1027/1028 被 gap 拒）
  });

  it("订阅基线：新接入直接采用 baseSeq，无死锁", () => {
    const s = new InboundStream("st_t1", 599);
    // 流已到 600——基线 599 后首帧 600 直接投递
    expect(s.accept(frame(600))).toMatchObject({ kind: "deliver" });
    expect(s.base()).toBe(600);
  });

  it("ACK 合并：32 帧或 250ms 到点", () => {
    const s = new InboundStream("st_t1");
    for (let i = 1; i <= 32; i++) s.accept(frame(i));
    expect(s.ackDue(1000, 0)).toBe(true);
    expect(s.flushAck()).toEqual({ streamId: "st_t1", upTo: 32 });
    expect(s.flushAck()).toBeNull();
    expect(s.ackDue(1000, 1000)).toBe(false);
    // 时间到点（帧数不够但超时）
    for (let i = 33; i <= 35; i++) s.accept(frame(i));
    expect(s.ackDue(2000, 1000)).toBe(true);
    expect(s.flushAck()).toEqual({ streamId: "st_t1", upTo: 35 });
  });
});

describe("OutboxStream 保留语义", () => {
  it("命令条目保留至 response 认领（不因 ACK 释放）", () => {
    const o = new OutboxStream("st_c1");
    const { seq } = o.enqueue({ command: "prompt", id: "m1" }, "command", "dev_1|g1");
    o.applyAck(seq);
    expect(o.pending().length).toBe(1); // ACK 不释放命令条目
    expect(o.releaseClaim("dev_1|g1")).toBe(true);
    expect(o.pending().length).toBe(0);
  });

  it("事件条目随 ACK 水位释放；cursor 重放只送未 ACK", () => {
    const o = new OutboxStream("st_t1");
    o.enqueue({}, "event", null);
    o.enqueue({}, "event", null);
    o.enqueue({}, "event", null);
    expect(o.replayFrom(0).length).toBe(3);
    o.applyAck(2);
    expect(o.replayFrom(2).length).toBe(1);
    expect(o.lastAckedSeq()).toBe(2);
  });

  it("enqueue 返回 {seq, frame}（双字段消费）", () => {
    const o = new OutboxStream("st_e");
    const enq = o.enqueue({ x: 1 }, "event", null);
    expect(enq.seq).toBe(1);
    expect(enq.frame.seq).toBe(1);
    expect(enq.frame.body).toEqual({ x: 1 });
  });

  it("nextSeq 单调；重放窗口上限可判定", () => {
    const o = new OutboxStream("st_t1");
    expect(o.nextSeqPeek()).toBe(1);
    o.enqueue({}, "event", null);
    expect(o.nextSeqPeek()).toBe(2);
  });
});

describe("分片/重组", () => {
  it("小帧不分片（null）；大帧切片后重组还原", () => {
    expect(chunkFrame("{}")).toBeNull();
    const big = JSON.stringify({ kind: "event", streamId: "st_t1", seq: 1, body: { blob: "x".repeat(5 * 1024 * 1024) } });
    const chunks = chunkFrame(big, 1024 * 1024)!;
    expect(chunks.length).toBe(6);
    const r = new FrameReassembler({ streamId: "st_t1", seq: 1, segmentCount: chunks.length, totalBytes: Buffer.byteLength(big) });
    let out: { ok: true; frameJson: string } | null = null;
    for (const c of chunks) {
      const res = r.add(c);
      if (res.ok) out = res;
    }
    expect(out?.frameJson).toBe(big);
  });

  it("重复段拒；超限抛", () => {
    const r = new FrameReassembler({ streamId: "st", seq: 1, segmentCount: 2, totalBytes: 100 });
    const seg = { segmentId: 0, segmentCount: 2, totalBytes: 100, data: Buffer.from("aa").toString("base64") };
    r.add(seg);
    expect(r.add(seg)).toEqual({ ok: false, reason: "duplicate-segment" });
    expect(() => new FrameReassembler({ streamId: "st", seq: 1, segmentCount: REASSEMBLY_MAX_SEGMENTS + 1, totalBytes: 10 })).toThrow();
  });
});

describe("帧解析门（垃圾降级）", () => {
  it("parseFrame：合法/未知 kind/坏 seq/垃圾 JSON", () => {
    expect(parseFrame('{"kind":"event","streamId":"s","seq":1,"body":{}}')).not.toBeNull();
    expect(parseFrame('{"kind":"nope","streamId":"s","seq":1,"body":{}}')).toBeNull();
    expect(parseFrame('{"kind":"event","streamId":"s","seq":-1,"body":{}}')).toBeNull();
    expect(parseFrame("not json")).toBeNull();
    expect(parseFrame('{"kind":"event","streamId":"","seq":1,"body":{}}')).toBeNull();
  });

  it("parseChunkBody：形状校验全支路", () => {
    expect(parseChunkBody({ segmentId: 0, segmentCount: 1, totalBytes: 5, data: "YQ==" })).not.toBeNull();
    expect(parseChunkBody({ segmentId: 1, segmentCount: 1, totalBytes: 5, data: "YQ==" })).toBeNull();
    expect(parseChunkBody({ segmentId: 0, segmentCount: 0, totalBytes: 5, data: "YQ==" })).toBeNull();
    expect(parseChunkBody(null)).toBeNull();
    expect(parseChunkBody({ segmentId: 0.5, segmentCount: 1, totalBytes: 5, data: "YQ==" })).toBeNull();
  });
});
