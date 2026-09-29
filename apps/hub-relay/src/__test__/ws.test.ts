import { describe, expect, it } from "vitest";
import { acceptKey } from "@x-harness/remote-protocol";
import { WebSocketFrameReader } from "@x-harness/remote-protocol";
import { WebSocketFrameWriter } from "@x-harness/remote-protocol";
import { Writable } from "node:stream";

describe("握手", () => {
  it("acceptKey = base64(sha1(key + GUID))（RFC 6455 向量）", () => {
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });
});

class Sink extends Writable {
  chunks: Buffer[] = [];
  override _write(chunk: Buffer, _enc: string, cb: (e?: Error | null) => void): void {
    this.chunks.push(chunk);
    cb();
  }
  joined(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

describe("帧写入", () => {
  it("小帧（<126）头 2 字节；中帧（126..65535）头 4 字节；大帧头 10 字节", () => {
    const sink = new Sink();
    const w = new WebSocketFrameWriter(sink as unknown as import("node:stream").Stream & { write(d: Buffer): boolean });
    w.writeText("hi");
    expect(sink.joined().subarray(0, 2).toString("hex")).toBe("8102");
    const sink2 = new Sink();
    const w2 = new WebSocketFrameWriter(sink2 as unknown as import("node:stream").Stream & { write(d: Buffer): boolean });
    w2.writeText("x".repeat(300));
    const head = sink2.joined();
    expect(head[1]).toBe(126);
    expect(head.readUInt16BE(2)).toBe(300);
    const sink3 = new Sink();
    const w3 = new WebSocketFrameWriter(sink3 as unknown as import("node:stream").Stream & { write(d: Buffer): boolean });
    w3.writeText("y".repeat(70000));
    const head3 = sink3.joined();
    expect(head3[1]).toBe(127);
    expect(head3.readBigUInt64BE(2)).toBe(BigInt(70000));
  });

  it("客户端掩码小帧（RFC 6455 §5.3）：头含 mask 位 + 4B 掩码键", () => {
    const sink = new Sink();
    const w = new WebSocketFrameWriter(sink as unknown as import("node:stream").Stream & { write(d: Buffer): boolean }, { clientMask: true });
    w.writeText("hi");
    const out = sink.joined();
    expect(out[1]! & 0x80).toBe(0x80);
    expect(out.length).toBe(2 + 4 + 2);
    const r = new WebSocketFrameReader();
    r.push(out);
    expect(r.drainTextFrames()).toEqual(["hi"]);
  });

  it("客户端掩码中帧（126 档）与大帧（127 档）", () => {
    const mid = new Sink();
    const wMid = new WebSocketFrameWriter(mid as unknown as import("node:stream").Stream & { write(d: Buffer): boolean }, { clientMask: true });
    wMid.writeText("m".repeat(300));
    const headMid = mid.joined();
    expect(headMid[1]! & 0x7f).toBe(126);
    const rMid = new WebSocketFrameReader();
    rMid.push(headMid);
    expect(rMid.drainTextFrames()).toEqual(["m".repeat(300)]);
    const big = new Sink();
    const wBig = new WebSocketFrameWriter(big as unknown as import("node:stream").Stream & { write(d: Buffer): boolean }, { clientMask: true });
    wBig.writeText("b".repeat(70000));
    const rBig = new WebSocketFrameReader();
    rBig.push(big.joined());
    expect(rBig.drainTextFrames()).toEqual(["b".repeat(70000)]);
  });

  it("ping/close 帧单字节头", () => {
    const sink = new Sink();
    const w = new WebSocketFrameWriter(sink as unknown as import("node:stream").Stream & { write(d: Buffer): boolean });
    w.writePing();
    w.writeClose();
    expect(sink.joined().toString("hex")).toBe("89008800");
  });
});

describe("帧读取", () => {
  it("未掩码文本帧解码；控制帧走 onNonText", () => {
    const r = new WebSocketFrameReader();
    let nonText = 0;
    r.onNonText = () => {
      nonText++;
    };
    r.push(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    r.push(Buffer.from([0x89, 0x00]));
    expect(r.drainTextFrames()).toEqual(["hi"]);
    expect(nonText).toBe(1);
  });

  it("掩码文本帧解码（客户端→服务端形态）", () => {
    const r = new WebSocketFrameReader();
    const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const payload = Buffer.from("abc", "utf8");
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
    r.push(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
    expect(r.drainTextFrames()).toEqual(["abc"]);
  });

  it("超 64MiB 帧置 error（防线）", () => {
    const r = new WebSocketFrameReader();
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0xff;
    header.writeBigUInt64BE(BigInt(65 * 1024 * 1024 + 1), 2);
    r.push(header);
    r.drainTextFrames();
    expect(r.error).not.toBeNull();
  });

  it("F3 回归：RSV 位帧静默不计入文本（不崩）", () => {
    const r = new WebSocketFrameReader();
    r.push(Buffer.from([0x91, 0x01, 0x41]));
    expect(r.drainTextFrames()).toEqual([]);
    expect(r.error).toBe("unsupported rsv bits");
  });

  it("分片到达（半帧不产帧，补齐后产出）", () => {
    const r = new WebSocketFrameReader();
    const frame = Buffer.concat([Buffer.from([0x81, 0x03]), Buffer.from("xyz")]);
    r.push(frame.subarray(0, 3));
    expect(r.drainTextFrames()).toEqual([]);
    r.push(frame.subarray(3));
    expect(r.drainTextFrames()).toEqual(["xyz"]);
  });
});
