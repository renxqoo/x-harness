import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";

export interface HostAttachOptions {
  exec: { command: string; args: string[] };
  env: Record<string, string>;
  heartbeatDeadlineMs: number;
  onLine(line: string): void;
  onRestart(reason: string): void;
  log(message: string): void;
}

export interface HostHandle {
  readonly child: ChildProcess | null;
  deliver(line: string): DeliverOutcome;
  kill(): Promise<void>;
  alive(): boolean;
  /** 当前 host 子进程 pid（无子进程时 undefined）——供生命周期用例断言进程存活性 */
  childPid(): number | undefined;
}

/**
 * 投递结果。只回答「字节交出去了吗」，不裁决命令成败——成败由 host 回包说了算。
 *
 * `delivered: false` 只覆盖「管道已经不可写」这一种（host 已死 / stdin 已关），
 * 那时 host 从未见过这条命令，是干净的失败。它不是完备判据：host 正在退出、
 * exit 事件尚未派发时投递仍会报 delivered:true 而字节已丢——这类窗口由
 * onRestart 把残留 pending 判死、再由 dedup 挡重复执行兜住，不要在这里假完备。
 */
export type DeliverOutcome = { delivered: true } | { delivered: false };

/** 优雅退出宽限：超时则强杀，避免不读 stdin 的 host 靠对端配合才退出 */
const HOST_STOP_GRACE_MS = 2_000;
/** 强杀后等 exit 事件的宽限 */
const HOST_STOP_KILL_WAIT_MS = 1_000;

export function resolveHostBin(hostBin: string | null): { command: string; args: string[]; env?: Record<string, string> } {
  if (hostBin !== null && hostBin.length > 0) {
    return { command: hostBin, args: [] };
  }
  const repoRoot = process.cwd();
  const candidates = [join(repoRoot, "apps/host-hub/src/host/cli.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { command: process.execPath, args: [candidate] };
    }
  }
  throw new Error("host-hub binary not found: set gateway.json hostBin explicitly");
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class HostAttach {
  private child: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private lastHeartbeat = Date.now();
  private deadlined = false;
  private stopping = false;
  readonly events = new EventEmitter();

  constructor(private readonly options: HostAttachOptions) {}

  start(): void {
    this.spawnHost();
    this.timer = setInterval(() => {
      if (this.child === null) return;
      if (Date.now() - this.lastHeartbeat > this.options.heartbeatDeadlineMs) {
        this.options.log(`host heartbeat deadline exceeded (${this.options.heartbeatDeadlineMs}ms) — kill & restart`);
        void this.restart("heartbeat-deadline");
      }
    }, 1000);
  }

  private timer: ReturnType<typeof setInterval> | null = null;

  private spawnHost(): void {
    this.buffer = Buffer.alloc(0);
    this.lastHeartbeat = Date.now();
    this.deadlined = false;
    const child = spawn(this.options.exec.command, this.options.exec.args, { env: this.options.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => {
      this.lastHeartbeat = Date.now();
      this.ingest(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.options.log(`host stderr: ${chunk.toString("utf8").trimEnd()}`);
    });
    child.stdin?.on("error", (error: Error) => {
      this.options.log(`host stdin write failed: ${String(error)}`);
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.deadlined) return;
      this.options.onRestart(`host exited code=${String(code)} signal=${String(signal)}`);
      void this.restart(String(signal ?? code ?? "exit"));
    });
  }

  private ingest(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const nl = this.buffer.indexOf(0x0a);
      if (nl < 0) return;
      let line = this.buffer.subarray(0, nl).toString("utf8");
      this.buffer = this.buffer.subarray(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      this.options.onLine(line);
    }
  }

  async restart(reason: string): Promise<void> {
    this.deadlined = true;
    this.killChild();
    await sleep(200);
    if (this.stopping) return;
    this.spawnHost();
    this.options.onRestart(reason);
  }

  private killChild(): void {
    const child = this.child;
    if (child === null) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2000);
    this.child = null;
  }

  deliver(line: string): DeliverOutcome {
    const child = this.child;
    if (child === null || child.stdin === null || child.exitCode !== null) {
      return { delivered: false };
    }
    const stdin = child.stdin;
    if (stdin.destroyed || stdin.writableEnded || stdin.writable === false) {
      return { delivered: false };
    }
    stdin.write(`${line}\n`, "utf8", () => {});
    return { delivered: true };
  }

  alive(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  childPid(): number | undefined {
    return this.child?.pid;
  }

  killChildForTest(): void {
    this.child?.kill("SIGKILL");
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopping = true;
    this.deadlined = true;
    const child = this.child;
    this.child = null;
    if (child === null) return;
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      child.once("exit", done);
      // 对端不读 stdin 就看不到 end、不会自己退出——到期由这边动手杀，
      // 杀完再等一小拍收 exit，不留孤儿进程
      const killTimer = setTimeout(() => {
        if (child.exitCode !== null) {
          done();
          return;
        }
        child.kill("SIGKILL");
        setTimeout(done, HOST_STOP_KILL_WAIT_MS);
      }, HOST_STOP_GRACE_MS);
    });
  }
}
