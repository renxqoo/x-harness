import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WORKER_LINE_LIMIT } from "../shared/limits.ts";

export interface WorkerSpawnSpec {
  env: Record<string, string>;
  exec: { command: string; args: string[] };
  onLine: (line: string) => void;
  onViolation: (reason: string) => void;
  onClosed: () => void;
  stderrPrefix: string;
}

export interface WorkerHandle {
  uid: string;
  write(line: string): Promise<void>;
  kill(graceMs: number): void;
  eof(): void;
  readonly exited: Promise<void>;
}

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
  let buffer = Buffer.alloc(0);
  let violationReported = false;
  const exited = new Promise<void>((resolve) => {
    child.stdin.on("error", (error: Error) => {
      process.stderr.write(`${spec.stderrPrefix} stdin write failed: ${String(error)}\n`);
    });
    const settle = (): void => {
      if (closed) return;
      closed = true;
      resolve();
      spec.onClosed();
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
        spec.onLine(line.toString("utf8"));
      }
      if (buffer.length > WORKER_LINE_LIMIT) {
        if (!violationReported) {
          violationReported = true;
          spec.onViolation("worker line exceeds limit");
        }
        buffer = buffer.subarray(buffer.length - 1);
      }
    });
    child.stdout.on("close", settle);
    child.on("error", (error) => {
      process.stderr.write(`${spec.stderrPrefix} spawn error: ${String(error)}\n`);
      settle();
    });
    child.on("exit", () => {
      const fallback = setTimeout(() => settle(), 5_000);
      fallback.unref?.();
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
              void err;
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
      }
    },
    exited,
  };
  return handle;
}
