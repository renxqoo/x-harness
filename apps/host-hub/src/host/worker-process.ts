// worker 进程机械（DESIGN §7）：三形态自举 spawn（脚本 argv / 编译产物 /$bunfs/
// 探测）、串行 stdin 写、畸形/超长帧回调杀、**close（非 exit）才是死亡信号**
// （exit 可能先于管道残留数据派发）；失败句柄（spawn error）同样触发
// onClosed——预算槽不泄漏。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WORKER_LINE_LIMIT } from "../shared/limits.ts";

export interface WorkerSpawnSpec {
  /** 传给 worker 的 env（继承 host 环境 + 装配快照/目录注入由调用方组装） */
  env: Record<string, string>;
  /** worker 可执行形态解析（cli.ts 的 --internal-worker） */
  exec: { command: string; args: string[] };
  onLine: (line: string) => void;
  onViolation: (reason: string) => void;
  onClosed: () => void;
  stderrPrefix: string;
}

export interface WorkerHandle {
  uid: string;
  /** 串行写一行（LF 终结）；写失败 = 工人侧管道断 → 调用方走死亡结算 */
  write(line: string): Promise<void>;
  /** SIGTERM → 宽限 → SIGKILL */
  kill(graceMs: number): void;
  /** 关闭 stdin（优雅退出信号——EOF） */
  eof(): void;
  readonly exited: Promise<void>;
}

/** bun 三形态自解：脚本形态带 argv[1]；/$bunfs/ 编译形态免 argv */
export function workerExecPath(): { command: string; args: string[] } {
  const argv1 = process.argv[1];
  if (argv1 !== undefined && !argv1.startsWith("/$bunfs/")) {
    return { command: process.execPath, args: [argv1, "--internal-worker"] };
  }
  return { command: process.execPath, args: ["--internal-worker"] };
}

export function spawnWorker(spec: WorkerSpawnSpec): WorkerHandle {
  const uid = randomUUID();
  const child = spawn(spec.exec.command, spec.exec.args, {
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let closed = false;
  let writeTail: Promise<void> = Promise.resolve();
  let buffer = Buffer.alloc(0); // 字节缓冲（UTF-8 多字节不跨 chunk 劈裂）
  let violationReported = false;
  const exited = new Promise<void>((resolve) => {
    // eof 后的迟到写（stop 升级等竞窗）以回调错误结算——监听防 uncaught 'error'
    child.stdin.on("error", (error: Error) => {
      process.stderr.write(`${spec.stderrPrefix} stdin write failed: ${String(error)}\n`);
    });
    const settle = (): void => {
      if (closed) return;
      closed = true;
      resolve();
      spec.onClosed(); // close（drain 完）才是死亡信号——exit 事件不可作结算点
    };
    child.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const nl = buffer.indexOf(0x0a);
        if (nl === -1) break;
        const line = buffer.subarray(0, nl);
        buffer = buffer.subarray(nl + 1);
        if (line.length === 0) continue;
        if (line.length > WORKER_LINE_LIMIT && !violationReported) {
          violationReported = true;
          spec.onViolation("worker line exceeds limit");
          continue;
        }
        spec.onLine(line.toString("utf8")); // 整行字节定界后一次解码（无跨 chunk 劈裂）
      }
      // 残段上限（无换行的失控流不得无界积压）
      if (buffer.length > WORKER_LINE_LIMIT) {
        if (!violationReported) {
          violationReported = true;
          spec.onViolation("worker line exceeds limit");
        }
        buffer = buffer.subarray(buffer.length - 1); // 留 1 字节防半行粘连误判——丢弃残段
      }
    });
    child.stdout.on("close", settle);
    child.on("error", (error) => {
      // spawn 失败（ENOENT/EMFILE）：同样走 onClosed——句柄回收
      process.stderr.write(`${spec.stderrPrefix} spawn error: ${String(error)}\n`);
      settle();
    });
    child.on("exit", () => {
      // exit 先于 stdout drain 到达时等 close；close 缺席（极端）兜底结算
      setTimeout(() => settle(), 5_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() !== "") process.stderr.write(`${spec.stderrPrefix} ${line}\n`);
      }
    });
  });

  const handle: WorkerHandle = {
    uid,
    write(line: string): Promise<void> {
      writeTail = writeTail.then(
        () =>
          new Promise<void>((resolve) => {
            child.stdin.write(`${line}\n`, "utf8", (err) => {
              void err; // 写失败由 close 结算面统一对账（不在此合成——避免双路径）
              resolve();
            });
          }),
      );
      return writeTail;
    },
    kill(graceMs: number): void {
      const term = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已死：无操作
        }
      }, graceMs);
      child.once("close", () => clearTimeout(term));
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(term);
      }
    },
    eof(): void {
      try {
        child.stdin.end();
      } catch {
        // 已断：无操作
      }
    },
    exited,
  };
  return handle;
}
