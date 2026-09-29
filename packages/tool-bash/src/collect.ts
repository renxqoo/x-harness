import { mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const FULL_CAP_BYTES = 64 * 1024 * 1024;
const OUTPUT_LINE_CAP = 2_000;

function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  let start = buf.byteLength - maxBytes;
  while (start > 0 && ((buf[start] as number) & 0xc0) === 0x80) start -= 1;
  return buf.subarray(start).toString("utf8");
}

export class ChannelCollector {
  private readonly parts: string[] = [];
  readonly fullCapBytes: number;
  private readonly onChunk?: (text: string) => void;
  full = "";
  fullBytes = 0;
  fullCapped = false;
  truncated = false;

  constructor(options: { readonly fullCapBytes?: number; readonly onChunk?: (text: string) => void } = {}) {
    this.fullCapBytes = options.fullCapBytes ?? FULL_CAP_BYTES;
    this.onChunk = options.onChunk;
  }

  push(text: string): void {
    if (text === "") return;
    if (this.onChunk !== undefined) {
      try {
        this.onChunk(text);
      } catch {
      }
    }
    if (this.fullCapped) return;
    this.parts.push(text);
    this.full += text;
    this.fullBytes += Buffer.byteLength(text);
    if (this.fullBytes > this.fullCapBytes) {
      this.fullCapped = true;
      this.full = this.full.slice(0, this.fullCapBytes * 2);
      this.fullBytes = Buffer.byteLength(this.full);
    }
  }

  text(maxBytes: number): string {
    let joined = this.parts.join("");
    if (Buffer.byteLength(joined) > maxBytes) {
      this.truncated = true;
      joined = tailBytes(joined, maxBytes);
      const nl = joined.indexOf("\n");
      joined = nl >= 0 && Buffer.byteLength(joined) - Buffer.byteLength(joined.slice(nl + 1)) < maxBytes
        ? joined.slice(nl + 1)
        : joined;
    }
    const lines = joined.split("\n");
    const counted = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    if (counted > OUTPUT_LINE_CAP) {
      this.truncated = true;
      joined = lines.slice(-OUTPUT_LINE_CAP).join("\n");
    }
    return cleanAnsi(joined);
  }
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, "g");
const CR_RE = new RegExp("\\r(?!\\n)", "g");

export function cleanAnsi(text: string): string {
  return text.replace(CSI_RE, "").replace(OSC_RE, "").replace(CR_RE, "");
}

export async function pump(stream: ReadableStream<Uint8Array>, collector: ChannelCollector): Promise<void> {
  const reader = stream.getReader();
  const decoder = new StringDecoder("utf8");
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    collector.push(decoder.write(read.value));
  }
  collector.push(decoder.end());
}

export function writeSpill(dir: string, prefix: string, full: string): string | undefined {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${prefix}-${randomBytes(8).toString("hex")}.txt`);
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, full);
    } finally {
      closeSync(fd);
    }
    return path;
  } catch {
    return undefined;
  }
}
