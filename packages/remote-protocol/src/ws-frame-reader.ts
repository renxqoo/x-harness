const FRAME_MAX_BYTES = 64 * 1024 * 1024;

export class WebSocketFrameReader {
  private buffer = Buffer.alloc(0);
  error: string | null = null;
  onNonText: (() => void) | null = null;

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

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
    if ((first & 0x70) !== 0) {
      this.error = "unsupported rsv bits";
      return null;
    }
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
    this.onNonText?.();
    return { kind: "control" };
  }
}
