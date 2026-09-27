// 最小 WebSocket 服务端帧协议（RFC 6455 子集）：握手 Accept、文本帧、ping/pong、
// close。客户端侧连接（gateway/手机 dial）用同一 Writer/Reader。
import { createHash } from "node:crypto";
import type { Stream } from "node:stream";

export function acceptKey(secWebSocketKey: string): string {
  return createHash("sha1").update(`${secWebSocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

export class WebSocketFrameWriter {
  constructor(private readonly stream: Stream & { write(data: Buffer): boolean }) {}

  private writeFrame(opcode: number, payload: Buffer): void {
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    this.stream.write(Buffer.concat([header, payload]));
  }

  writeText(text: string): void {
    this.writeFrame(0x1, Buffer.from(text, "utf8"));
  }

  writePing(): void {
    this.writeFrame(0x9, Buffer.alloc(0));
  }

  writePong(): void {
    this.writeFrame(0xa, Buffer.alloc(0));
  }

  writeClose(): void {
    this.writeFrame(0x8, Buffer.alloc(0));
  }
}
