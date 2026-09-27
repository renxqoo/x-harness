// WebSocket 帧读取器（RFC 6455 子集）：文本帧排空 + 控制帧回调 + 64MiB 上限。
// 最小 WebSocket 帧读取器（RFC 6455 子集）：文本帧排空 + 控制帧回调。
const FRAME_MAX_BYTES = 64 * 1024 * 1024;

export class WebSocketFrameReader {
  private buffer = Buffer.alloc(0);
  error: string | null = null;
  /** 非文本帧（ping/pong/close）回调——活性跟踪 */
  onNonText: (() => void) | null = null;

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  /** 排出全部完整文本帧（服务端帧不掩码；客户端帧掩码——两者都解） */
  drainTextFrames(): string[] {
    const out: string[] = [];
    for (;;) {
      const parsed = this.parseOne();
      if (parsed === null) break;
      if (parsed.kind === "text" && parsed.text !== undefined) out.push(parsed.text);
    }
    return out;
  }

  private parseOne(): { kind: "text" | "control"; text?: string } | null {
    const buffer = this.buffer;
    if (buffer.length < 2) return null;
    const first = buffer[0]!;
    const second = buffer[1]!;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    const length7 = second & 0x7f;
    let length = length7;
    let offset = 2;
    if (length7 === 126) {
      if (buffer.length < 4) return null;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length7 === 127) {
      if (buffer.length < 10) return null;
      const big = buffer.readBigUInt64BE(2);
      if (big > FRAME_MAX_BYTES) {
        this.error = "frame too large";
        return null;
      }
      length = Number(big);
      offset = 10;
    }
    const maskKey = masked ? 4 : 0;
    if (buffer.length < offset + maskKey + length) return null;
    let payload = buffer.subarray(offset + maskKey, offset + maskKey + length);
    if (masked) {
      const mask = buffer.subarray(offset, offset + 4);
      const unmasked = Buffer.alloc(length);
      for (let i = 0; i < length; i++) unmasked[i] = payload[i]! ^ mask[i % 4]!;
      payload = unmasked;
    }
    this.buffer = buffer.subarray(offset + maskKey + length);
    if (opcode === 0x1) return { kind: "text", text: payload.toString("utf8") };
    // 控制帧（ping/pong/close）——回 pong 由 onNonText 挂钩方处理
    this.onNonText?.();
    return { kind: "control" };
  }
}

