import { STDOUT_RETRY_DELAY_MS, STDOUT_RETRY_MAX } from "./limits.ts";

export interface FrameWriter {
  write(line: string): Promise<void>;
  idle(): Promise<void>;
  dropped(): number;
}

export interface StdoutGuardOptions {
  onBroken?: (error: unknown) => void;
  retryMax?: number;
  retryDelayMs?: number;
}

export function takeOverStdout(options: StdoutGuardOptions = {}): FrameWriter {
  const retryMax = options.retryMax ?? STDOUT_RETRY_MAX;
  const retryDelayMs = options.retryDelayMs ?? STDOUT_RETRY_DELAY_MS;
  const realWrite = process.stdout.write.bind(process.stdout);
  let dropped = 0;
  let tail: Promise<void> = Promise.resolve();

  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) => {
      process.stderr.write(`${level}: ${args.map((a) => String(a)).join(" ")}\n`);
    };
  }
  (process.stdout as { write: unknown }).write = (chunk: unknown): boolean => {
    if (typeof chunk === "string" && chunk.endsWith("\n") && chunk.startsWith(`{"type":`)) {
      void writer.write(chunk.slice(0, -1));
      return true;
    }
    return toStderr(chunk);
  };

  function toStderr(chunk: unknown): boolean {
    try {
      process.stderr.write(typeof chunk === "string" ? chunk : String(chunk));
    } catch {
    }
    return true;
  }

  function writeRaw(line: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const attempt = (left: number): void => {
        realWrite(`${line}\n`, "utf8", (err) => {
          if (err === undefined || err === null) {
            resolve();
            return;
          }
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "EPIPE") {
            options.onBroken?.(err);
            resolve();
            return;
          }
          if ((code === "ENOBUFS" || code === "EAGAIN") && left > 0) {
            setTimeout(() => attempt(left - 1), retryDelayMs);
            return;
          }
          dropped += 1;
          process.stderr.write(`stdout-guard: frame dropped (${String(err)})\n`);
          resolve();
        });
      };
      attempt(retryMax);
    });
  }

  const writer: FrameWriter = {
    write(line: string): Promise<void> {
      tail = tail.then(() => writeRaw(line));
      return tail;
    },
    idle(): Promise<void> {
      return tail;
    },
    dropped: () => dropped,
  };
  return writer;
}
