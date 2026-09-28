// 最小 WebSocket 服务端帧协议（RFC 6455 子集）：握手 Accept、文本帧、ping/pong、
// close。客户端侧连接（gateway/手机 dial）用同一 Writer/Reader。
// WebSocket 帧写入器（RFC 6455 子集）：文本/ping/pong/close。
import { createHash, randomBytes } from "node:crypto";
import type { Stream } from "node:stream";

export function acceptKey(secWebSocketKey: string): string {
  return createHash("sha1").update(`${secWebSocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

export class WebSocketFrameWriter {
  /** 客户端形态（RFC 6455 客户端帧必须掩码）——服务端帧不掩码 */
  private readonly maskKey: Buffer | null;

  constructor(
    private readonly stream: Stream & { write(data: Buffer): boolean },
    options?: { clientMask?: boolean },
  ) {
    this.maskKey = options?.clientMask === true ? randomBytes(4) : null;
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const masked = this.maskKey !== null;
    const length = payload.length;
    const lengthBits = masked ? 0x80 : 0x00;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, lengthBits | length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = lengthBits | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = lengthBits | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    if (!masked) {
      this.stream.write(Buffer.concat([header, payload]));
      return;
    }
    const mask = this.maskKey!;
    const masked2 = Buffer.alloc(length);
    for (let i = 0; i < length; i++) masked2[i] = payload[i]! ^ mask[i % 4]!;
    this.stream.write(Buffer.concat([header, mask, masked2]));
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
