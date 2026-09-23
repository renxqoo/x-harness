// 任务日志文件槽（docs/TASK-PUSH-DESIGN.md §2.2）：stdout/stderr 双泵到达序流式落盘。
// 单 WriteStream = 单写者（write 提交序即落盘序——双泵各自异步 append 的执行序无保证）；
// 清洗（ANSI 转义 + 裸 \r）为跨 chunk 状态机——转义序列与 \r 均可劈在 chunk 边界，
// 逐 chunk 调 cleanAnsi 会漏判（cleanAnsi 的三条正则作用于 join 后全文，流式化须逐态保持）；
// 写帽字节精确 + 截断点 UTF-8 续字节回退；写失败标记不静默（通知面据 writeError 注记）。

import { createWriteStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI_PARAM = /[0-9;?]/;

/** 流式清洗状态：none 正常；esc 已吃 ESC 待定；csi 攒 ESC[ 参数；osc 攒 OSC 正文；
 *  oscEsc OSC 内 ESC（下一字节 \\ 终结，否则回归 OSC 正文）。EOF 时未终结序列原样
 *  保留（fail-visible——与 cleanAnsi 的全文正则不同，流式无法回看，保留优于静默丢字）。 */
type CleanState = "none" | "esc" | "csi" | "osc" | "oscEsc";

export class StreamCleaner {
  private state: CleanState = "none";
  private buf = ""; // csi/osc/oscEsc 态的暂存（序列未终结，尚未裁决去留）
  private stMark: number | undefined; // OSC 内最后一个 ESC\ 之后的 buf 位（贪婪正则的回溯点）
  private pendingCr = false; // 尾部 \r 暂存：待下 chunk 首字节裁决（\n 保留 CRLF，否则删裸 \r）

  step(text: string): string {
    let out = "";
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i] as string;
      if (this.state === "none") out += this.stepNone(ch);
      else if (this.state === "esc") out += this.stepEsc(ch);
      else if (this.state === "csi") out += this.stepCsi(ch);
      else if (this.state === "osc") out += this.stepOsc(ch);
      else out += this.stepOscEsc(ch);
    }
    return out;
  }

  private stepNone(ch: string): string {
    if (this.pendingCr) {
      this.pendingCr = false;
      if (ch === "\n") return "\r\n"; // CRLF 完整保留（\n 消费于此）
      // 非 \n 跟随：悬置 \r 是裸 \r——删除（正则 \r(?!\n) 的流式等价），ch 继续正常处理
    }
    if (ch === ESC) this.state = "esc";
    else if (ch === "\r") this.pendingCr = true;
    else return ch;
    return "";
  }

  private stepEsc(ch: string): string {
    if (ch === "[") {
      this.state = "csi";
      this.buf = "";
    } else if (ch === "]") {
      this.state = "osc";
      this.buf = "";
      this.stMark = undefined;
    } else {
      this.state = "none";
      return `${ESC}${ch}`; // ESC+其他：cleanAnsi 两条序列正则均不匹配——原样保留
    }
    return "";
  }

  private stepCsi(ch: string): string {
    if (CSI_PARAM.test(ch)) {
      this.buf += ch;
    } else if (isLetter(ch)) {
      this.buf = ""; // 序列完整——丢弃
      this.state = "none";
    } else {
      this.state = "none";
      const held = `${ESC}[${this.buf}${ch}`; // 非参数非终结：正则不匹配——原样保留
      this.buf = "";
      return held;
    }
    return "";
  }

  private stepOsc(ch: string): string {
    if (ch === BEL) {
      this.buf = ""; // BEL 终结——丢弃（贪婪语义：ST 只是正文，BEL 才是硬边界）
      this.stMark = undefined;
      this.state = "none";
    } else if (ch === ESC) {
      this.buf += ESC;
      this.state = "oscEsc";
    } else {
      this.buf += ch; // [^BEL]* 正文
    }
    return "";
  }

  private stepOscEsc(ch: string): string {
    if (ch === "\\") {
      this.buf += "\\";
      this.stMark = this.buf.length; // 潜在终结：EOF 无 BEL 时回溯删到此（正则回溯的流式等价）
    } else {
      this.buf += ch; // 非终结：悬置 ESC 与该字节都属 OSC 正文（buf 已含 ESC）
    }
    this.state = "osc";
    return "";
  }

  /** EOF 收尾：未终结序列原样吐出（OSC 按 stMark 回溯——无终结符吐全部，有则吐最后
   *  ST 之后）；悬置 \r 丢弃（其后必无 \n——裸 \r 语义成立） */
  end(): string {
    let held = "";
    if (this.state === "esc") held = ESC;
    else if (this.state === "csi") held = `${ESC}[${this.buf}`;
    else if (this.state === "osc" || this.state === "oscEsc") {
      // 无终结符：正则不匹配，原样吐全部；有 ST：回溯删到最后 ST，其后正文吐出
      held = this.stMark === undefined ? `${ESC}]${this.buf}` : this.buf.slice(this.stMark);
    }
    this.state = "none";
    this.buf = "";
    this.stMark = undefined;
    this.pendingCr = false;
    return held;
  }
}

function isLetter(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
}

export interface LogSinkStats {
  /** 已提交写字节（清洗后原文口径；写失败窗口内已提交未确知的部分不回退——writeError 在场时数字不作完整性承诺） */
  readonly writtenBytes: number;
  /** 写帽外丢弃字节（含写失败后到达的输出） */
  readonly droppedBytes: number;
  /** 写帽触达（文件保留已写前缀） */
  readonly truncated: boolean;
  /** 写失败事实（磁盘满/权限等——通知面据此注记 log incomplete） */
  readonly writeError: string | undefined;
}

export interface TaskLogSink {
  readonly logPath: string;
  /** pump 侧同步调用：清洗 → 帽判定 → 提交流写（流内单写者按提交序落盘） */
  accept(text: string): void;
  /** 收尾：EOF 清洗 flush + end 流 + 等全部缓冲落盘；幂等（双 finalize 路径共用） */
  close(): Promise<void>;
  stats(): LogSinkStats;
}

export function createLogSink(logPath: string, capBytes: number): TaskLogSink {
  const cleaner = new StreamCleaner();
  const stream = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  let writtenBytes = 0;
  let droppedBytes = 0;
  let truncated = false;
  let writeError: string | undefined;
  let ended = false;
  let closePromise: Promise<void> | undefined;
  stream.on("error", (error: Error) => {
    const text = error.message === "" ? String(error) : error.message;
    if (writeError === undefined) {
      writeError = text;
      // 主产物写失败不静默（磁盘满/权限——通知注记之外唯一的本进程可见面）
      process.stderr.write(`[x-harness] tool-bash: task log write failed (${logPath}): ${text}\n`);
    }
  });
  const emit = (text: string): void => {
    if (text === "") return;
    if (writeError !== undefined || truncated || ended) {
      droppedBytes += Buffer.byteLength(text); // 帽外/失败后/close 后到达——如实计数
      return;
    }
    const buf = Buffer.from(text, "utf8");
    const budget = capBytes - writtenBytes;
    if (buf.byteLength <= budget) {
      try {
        stream.write(buf);
        writtenBytes += buf.byteLength; // 提交成功才计（同步 throw 未落盘——计 dropped）
      } catch (error) {
        writeError = String(error);
        droppedBytes += buf.byteLength;
      }
      return;
    }
    let end = budget;
    while (end > 0 && ((buf[end] as number) & 0xc0) === 0x80) end -= 1; // 截断点回退到字符边界
    if (end > 0) {
      try {
        stream.write(buf.subarray(0, end));
        writtenBytes += end;
      } catch {
        /* error 事件置 writeError——本块按 dropped 计（下方统一） */
        end = 0;
      }
    }
    droppedBytes += buf.byteLength - end;
    truncated = true;
  };
  return {
    logPath,
    accept: (text: string): void => {
      emit(cleaner.step(text));
    },
    close: (): Promise<void> => {
      if (closePromise !== undefined) return closePromise;
      closePromise = (async () => {
        emit(cleaner.end());
        ended = true;
        if (stream.destroyed) return; // error 先行已销毁：finish/error 均不再发——直接收口（回归：曾在此永挂）
        await new Promise<void>((resolve) => {
          const done = (): void => resolve();
          stream.once("close", done); // close 必发（含 destroy 路径）——finish/error 只是提早口
          stream.once("finish", done);
          stream.once("error", done);
          stream.end();
        });
      })();
      return closePromise;
    },
    stats: (): LogSinkStats => ({
      writtenBytes,
      droppedBytes,
      truncated,
      // 失败窗口内已提交未确知的字节无法回退——writeError 在场时以注记为准，数字不作完整性承诺
      writeError,
    }),
  };
}

/** 双流全程并发消费到 EOF（防子进程堵管假挂）：StringDecoder 跨 chunk 撕裂 UTF-8 不出替换符 */
export async function pumpToSink(stream: ReadableStream<Uint8Array>, sink: TaskLogSink): Promise<void> {
  const reader = stream.getReader();
  const decoder = new StringDecoder("utf8");
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    sink.accept(decoder.write(read.value));
  }
  sink.accept(decoder.end());
}
