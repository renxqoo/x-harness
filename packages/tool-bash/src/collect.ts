// 输出收集共享原语（docs/TOOLBOX.md §4——前台 bash 与后台任务共用）：
// ChannelCollector（滚动全文 + 截断保尾结算 + 保留帽）、pump（双流消费）、writeSpill（全文落盘）。

import { mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const FULL_CAP_BYTES = 64 * 1024 * 1024;
const OUTPUT_LINE_CAP = 2_000;

/** 字节精确取尾：起始位置若落在 UTF-8 续字节（0b10xxxxxx）则前移到字符边界——
 *  不撕裂多字节字符、必有推进（对比字符数切片：≥3 字节/字符的输出会使切片成为无进展空转） */
function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  let start = buf.byteLength - maxBytes;
  while (start > 0 && ((buf[start] as number) & 0xc0) === 0x80) start -= 1;
  return buf.subarray(start).toString("utf8");
}

export class ChannelCollector {
  private readonly parts: string[] = [];
  readonly fullCapBytes: number;
  /** 增量观察回调（可选）：push 早段同步调用（在保留帽早退**之前**——过帽仍流，
   *  对齐直执行面 truncated 语义）；观察者异常防御性吞掉——不得杀死 pump */
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
        /* 观察者 throw 不杀 pump：reader 继续 cancel 语义由 pump 自身承担 */
      }
    }
    if (this.fullCapped) return;
    this.parts.push(text);
    this.full += text;
    this.fullBytes += Buffer.byteLength(text);
    if (this.fullBytes > this.fullCapBytes) {
      this.fullCapped = true; // 保留帽：停止累积（内存 DoS 防护）
      this.full = this.full.slice(0, this.fullCapBytes * 2);
      this.fullBytes = Buffer.byteLength(this.full); // 计数与保留体对齐（截断后按实际字节）
    }
  }

  /** 截断保尾部（完整行边界起，单行超帽允许行中截）+ 行数帽；字节精确取尾不越展示帽口径 */
  text(maxBytes: number): string {
    let joined = this.parts.join("");
    if (Buffer.byteLength(joined) > maxBytes) {
      this.truncated = true;
      joined = tailBytes(joined, maxBytes);
      const nl = joined.indexOf("\n");
      joined = nl >= 0 && Buffer.byteLength(joined) - Buffer.byteLength(joined.slice(nl + 1)) < maxBytes
        ? joined.slice(nl + 1) // 从完整行边界起（行内剩余仍 ≤ 帽）
        : joined; // 单行超帽：行中截（保尾部优先于行完整）
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
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"); // ESC[ 序列（ANSI CSI）
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, "g"); // ESC]...BEL OSC 序列
const CR_RE = new RegExp("\\r(?!\\n)", "g"); // 裸 \r（非 CRLF）

/** ANSI 转义与裸 \r 清洗（token 噪声；锚定 ESC——普通 [word] 文本不受影响；前台展示与后台增量读同口径） */
export function cleanAnsi(text: string): string {
  return text.replace(CSI_RE, "").replace(OSC_RE, "").replace(CR_RE, "");
}

/** 双流全程并发消费：即使截断/spill 失败也读到 EOF 丢弃（防子进程堵管假挂） */
export async function pump(stream: ReadableStream<Uint8Array>, collector: ChannelCollector): Promise<void> {
  const reader = stream.getReader();
  const decoder = new StringDecoder("utf8");
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    collector.push(decoder.write(read.value)); // StringDecoder：跨 chunk 撕裂 UTF-8 不出替换符
  }
  collector.push(decoder.end());
}

/** 截断全文落盘（mkdtemp 0700 目录内 wx 0600 随机名——名不含 command/path 任何用户成分） */
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
