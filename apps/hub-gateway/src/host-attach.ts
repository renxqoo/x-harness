// host-hub 附着（DESIGN §4/§5）：spawn host 进程、stdin/stdout JSONL 泵、心跳死线监督
// （>10s 杀+拉起）、response 帧分类回调（前缀识别不 parse body——host frame-classify 同思路）。
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface HostAttachOptions {
  /** host 二进制解析结果（command + args） */
  exec: { command: string; args: string[] };
  env: Record<string, string>;
  /** 心跳死线（ms） */
  heartbeatDeadlineMs: number;
  onLine(line: string): void;
  onRestart(reason: string): void;
  log(message: string): void;
}

export interface HostHandle {
  readonly child: ChildProcess | null;
  write(line: string): boolean;
  kill(): Promise<void>;
  alive(): boolean;
}

/** hostBin 解析序（§3.3）：显式配置 → 仓库 dist → PATH */
export function resolveHostBin(hostBin: string | null): { command: string; args: string[] } {
  if (hostBin !== null && hostBin.length > 0) {
    return { command: hostBin, args: [] };
  }
  return { command: process.execPath, args: [process.argv[1] ?? "host-hub"] };
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
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.deadlined) return; // 重启流程中——重启路径自己拉起
      this.options.onRestart(`host exited code=${String(code)} signal=${String(signal)}`);
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

  write(line: string): boolean {
    const child = this.child;
    if (child === null || child.stdin === null || child.exitCode !== null) return false;
    return child.stdin.write(`${line}\n`);
  }

  alive(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.deadlined = true;
    const child = this.child;
    if (child === null) return;
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      child.once("exit", done);
      setTimeout(done, 5000);
    });
  }
}
