// stdout 接管（DESIGN §9）：协议帧只走接管时抓到的原始句柄 + 全局串行队列（任意两帧
// 不交错）；杂散 console.* 改道 stderr（Bun 下 console 不走 stdout.write，两层都补）。
// ENOBUFS/EAGAIN 是暂态：10ms 重试有上限（100 次后降级 stderr 丢帧 + 计数）；
// EPIPE 是终态：触发优雅退出回调。
import { STDOUT_RETRY_DELAY_MS, STDOUT_RETRY_MAX } from "./limits.ts";

export interface FrameWriter {
  /** 串行写一帧（行首已含换行尾）；resolve = 已入 OS 管道 */
  write(line: string): Promise<void>;
  /** 全部已入队帧冲刷完成的尾部（退出前 await——防末帧截断） */
  idle(): Promise<void>;
  /** 降级统计（排障/监控） */
  dropped(): number;
}

export interface StdoutGuardOptions {
  /** 写失败终态（EPIPE）回调——调用方走优雅退出 */
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

  // 杂散日志改道 stderr：patch console + stdout.write 双层（直写 fd/Bun.write 不可拦截
  // ——documented gap，协议帧走本 writer 不受影响）
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) => {
      process.stderr.write(`${level}: ${args.map((a) => String(a)).join(" ")}\n`);
    };
  }
  (process.stdout as { write: unknown }).write = (chunk: unknown): boolean => {
    if (typeof chunk === "string" && chunk.endsWith("\n") && chunk.startsWith(`{"type":`)) {
      // 协议帧形态的直写（罕见：三方库模拟）也入队，保持串行
      void writer.write(chunk.slice(0, -1));
      return true;
    }
    return toStderr(chunk);
  };

  function toStderr(chunk: unknown): boolean {
    try {
      process.stderr.write(typeof chunk === "string" ? chunk : String(chunk));
    } catch {
      // stderr 也坏：进程级故障，静默
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
            resolve(); // 终态：不再重试；进程走优雅退出
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
