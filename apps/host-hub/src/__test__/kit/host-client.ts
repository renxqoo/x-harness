// 真进程 host-client 装置（MIGRATION §5 test/harness 移植）：spawn cli.ts 真进程
// （script 模式 env）——帧解析/等待器/worker pid 探测。
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScriptStep } from "../../shared/script-adapter.ts";

export interface HostFrame {
  type: string;
  [key: string]: unknown;
}

interface Waiter {
  pred: (frame: HostFrame) => boolean;
  resolve: (frame: HostFrame) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface HostHandle {
  proc: ReturnType<typeof spawn>;
  lines: HostFrame[];
  send(cmd: unknown): void;
  wait(pred: (frame: HostFrame) => boolean, label: string, timeoutMs?: number): Promise<HostFrame>;
  response(id: string, timeoutMs?: number): Promise<HostFrame>;
  event(name: string, payloadMatch?: (payload: unknown) => boolean, timeoutMs?: number): Promise<HostFrame>;
  end(): void;
  exited(): Promise<number>;
  agentDir: string;
  sessionsRoot: string;
  dumpFrames(): void;
}

export interface StartHostOptions {
  script: readonly ScriptStep[];
  env?: Record<string, string | undefined>;
  /** 源码形态入口（缺省 cli.ts）；双形态冒烟传 dist 产物路径 */
  entry?: string;
}

export async function startHost(options: StartHostOptions): Promise<HostHandle> {
  const agentDir = await mkdtemp(join(tmpdir(), "hub-host-proc-"));
  const entry = options.entry ?? join(import.meta.dirname, "../../host/cli.ts");
  const proc = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      HUB_AGENT_DIR: agentDir,
      HUB_SESSIONS_ROOT: join(agentDir, "sessions"),
      // 环境防污染：宿主 shell 的 hub 变量（冒烟/开发残留）不得泄漏进测试子进程
      HUB_WORKER_DISPATCHED: undefined,
      HUB_WORKER_PROVIDER: "script",
      HUB_WORKER_SCRIPT: JSON.stringify(options.script),
      ...options.env,
    } as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: HostFrame[] = [];
  const waiters: Waiter[] = [];
  let buffer = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (raw.trim() === "") continue;
      let frame: HostFrame;
      try {
        frame = JSON.parse(raw) as HostFrame;
      } catch {
        continue;
      }
      lines.push(frame);
      const matched = waiters.filter((waiter) => waiter.pred(frame));
      for (const waiter of matched) {
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
      }
      for (const waiter of matched) {
        waiter.resolve(frame);
      }
    }
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim() !== "") process.stderr.write(`[host-proc] ${line}\n`);
    }
  });
  const handle: HostHandle = {
    proc,
    lines,
    agentDir,
    sessionsRoot: join(agentDir, "sessions"),
    send(cmd: unknown): void {
      proc.stdin.write(`${JSON.stringify(cmd)}\n`);
    },
    wait(pred, label, timeoutMs = 30_000): Promise<HostFrame> {
      for (const frame of lines) {
        if (pred(frame)) return Promise.resolve(frame);
      }
      return new Promise((resolve, reject) => {
        const waiter: Waiter = {
          pred,
          resolve,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error(`wait timeout: ${label}; frames=${lines.filter((f) => f.type !== "heartbeat").length}`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    response(id, timeoutMs = 30_000): Promise<HostFrame> {
      return handle.wait((frame) => frame.type === "response" && frame.id === id, `response ${id}`, timeoutMs);
    },
    event(name, payloadMatch, timeoutMs = 30_000): Promise<HostFrame> {
      return handle.wait((frame) => frame.type === "event" && frame.name === name && (payloadMatch === undefined || payloadMatch(frame.payload)), `event ${name}`, timeoutMs);
    },
    end(): void {
      proc.stdin.end();
    },
    exited(): Promise<number> {
      return new Promise((resolve) => {
        if (proc.exitCode !== null) {
          resolve(proc.exitCode);
          return;
        }
        proc.on("exit", (code) => resolve(code ?? -1));
      });
    },
    dumpFrames(): void {
      for (const frame of lines.filter((f) => f.type !== "heartbeat").slice(0, 30)) {
        process.stderr.write(`  ${JSON.stringify(frame).slice(0, 160)}\n`);
      }
    },
  };
  // 就绪：首帧心跳（host 心跳 1Hz——30s 宽放）
  await handle.wait((frame) => frame.type === "heartbeat", "first heartbeat");
  return handle;
}

export function workerPids(hostPid: number): number[] {
  try {
    const out = execSync(`pgrep -P ${String(hostPid)}`, { encoding: "utf8" });
    return out.split("\n").filter((line) => line.trim() !== "").map(Number);
  } catch {
    return [];
  }
}

export function aliveOf(pids: readonly number[]): boolean[] {
  return pids.map((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

/** 驱动基元：prompt → 受理 ack + settled 收敛 */
export async function drivePrompt(host: HostHandle, fields: { threadId: string; id: string; message: string }): Promise<void> {
  host.send({ type: "prompt", id: fields.id, threadId: fields.threadId, message: fields.message });
  const ack = await host.response(fields.id);
  if (!ack.success) {
    const err = ack.error as { code?: string; message?: string } | undefined;
    throw new Error(`prompt rejected: ${err !== undefined ? `${err.code ?? "?"}: ${err.message ?? ""}` : "no error payload"}`);
  }
  await host.event("settled", (payload) => (payload as { sendId?: string }).sendId === fields.id);
}

export function contentText(event: unknown): string {
  const payload = event as { content?: Array<{ type?: string; text?: string }> };
  if (!Array.isArray(payload?.content)) return "";
  return payload.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
}
