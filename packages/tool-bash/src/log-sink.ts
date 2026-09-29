import { createWriteStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI_PARAM = /[0-9;?]/;

type CleanState = "none" | "esc" | "csi" | "osc" | "oscEsc";

export class StreamCleaner {
  private state: CleanState = "none";
  private buf = "";
  private stMark: number | undefined;
  private pendingCr = false;

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
      if (ch === "\n") return "\r\n";
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
      return `${ESC}${ch}`;
    }
    return "";
  }

  private stepCsi(ch: string): string {
    if (CSI_PARAM.test(ch)) {
      this.buf += ch;
    } else if (isLetter(ch)) {
      this.buf = "";
      this.state = "none";
    } else {
      this.state = "none";
      const held = `${ESC}[${this.buf}${ch}`;
      this.buf = "";
      return held;
    }
    return "";
  }

  private stepOsc(ch: string): string {
    if (ch === BEL) {
      this.buf = "";
      this.stMark = undefined;
      this.state = "none";
    } else if (ch === ESC) {
      this.buf += ESC;
      this.state = "oscEsc";
    } else {
      this.buf += ch;
    }
    return "";
  }

  private stepOscEsc(ch: string): string {
    if (ch === "\\") {
      this.buf += "\\";
      this.stMark = this.buf.length;
    } else {
      this.buf += ch;
    }
    this.state = "osc";
    return "";
  }

  end(): string {
    let held = "";
    if (this.state === "esc") held = ESC;
    else if (this.state === "csi") held = `${ESC}[${this.buf}`;
    else if (this.state === "osc" || this.state === "oscEsc") {
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
  readonly writtenBytes: number;
  readonly droppedBytes: number;
  readonly truncated: boolean;
  readonly writeError: string | undefined;
}

export interface TaskLogSink {
  readonly logPath: string;
  accept(text: string): void;
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
      process.stderr.write(`[x-harness] tool-bash: task log write failed (${logPath}): ${text}\n`);
    }
  });
  const emit = (text: string): void => {
    if (text === "") return;
    if (writeError !== undefined || truncated || ended) {
      droppedBytes += Buffer.byteLength(text);
      return;
    }
    const buf = Buffer.from(text, "utf8");
    const budget = capBytes - writtenBytes;
    if (buf.byteLength <= budget) {
      try {
        stream.write(buf);
        writtenBytes += buf.byteLength;
      } catch (error) {
        writeError = String(error);
        droppedBytes += buf.byteLength;
      }
      return;
    }
    let end = budget;
    while (end > 0 && ((buf[end] as number) & 0xc0) === 0x80) end -= 1;
    if (end > 0) {
      try {
        stream.write(buf.subarray(0, end));
        writtenBytes += end;
      } catch {
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
        if (stream.destroyed) return;
        await new Promise<void>((resolve) => {
          const done = (): void => resolve();
          stream.once("close", done);
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
      writeError,
    }),
  };
}

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
