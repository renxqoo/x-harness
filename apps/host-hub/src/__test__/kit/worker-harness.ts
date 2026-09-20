// worker 内嵌装置（MIGRATION §5 worker-harness 移植）：注入 stdin/stdout 跑真
// runWorker（无进程 spawn——worker 在测试内运行，覆盖率真实计入）；script-adapter
// 剧本驱动确定性 LLM。
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorker } from "../../worker/worker.ts";
import type { FrameWriter } from "../../shared/stdout-guard.ts";
import type { ScriptStep } from "../../shared/script-adapter.ts";

export class FakeInput extends EventEmitter {
  send(text: string): void {
    this.emit("data", Buffer.from(`${text}\n`, "utf8"));
  }
  end(): void {
    this.emit("end");
  }
}

export interface CapturedWriter extends FrameWriter {
  lines: string[];
}

export function captureWriter(): CapturedWriter {
  const lines: string[] = [];
  const writer: CapturedWriter = {
    lines,
    write(line: string): Promise<void> {
      lines.push(line);
      return Promise.resolve();
    },
    idle(): Promise<void> {
      return Promise.resolve();
    },
    dropped: () => 0,
  };
  return writer;
}

export interface Frame {
  type: string;
  [key: string]: unknown;
}

export function framesOf(captured: readonly string[]): Frame[] {
  return captured.map((line) => JSON.parse(line) as Frame);
}

export interface WaitOptions {
  timeoutMs?: number;
  /** 只扫描该下标之后的帧（历史帧不复用——多次弹窗场景） */
  afterIndex?: number;
}

export async function waitFrame(captured: readonly string[], pred: (frame: Frame) => boolean, options: number | WaitOptions = 10_000): Promise<Frame> {
  const opts = typeof options === "number" ? { timeoutMs: options } : options;
  const started = Date.now();
  for (;;) {
    for (const line of captured.slice(opts.afterIndex ?? 0)) {
      const frame = JSON.parse(line) as Frame;
      if (pred(frame)) return frame;
    }
    if (Date.now() - started > (opts.timeoutMs ?? 10_000)) {
      const tail = captured.slice(-12).map((line) => line.slice(0, 160)).join("\n");
      throw new Error(`waitFrame timeout; last frames:\n${tail}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

export async function waitResponse(captured: readonly string[], command: string, id?: string): Promise<Frame> {
  return waitFrame(captured, (frame) => frame.type === "response" && frame.command === command && (id === undefined || frame.id === id));
}

export async function waitEvent(captured: readonly string[], name: string, payloadMatch?: (payload: unknown) => boolean): Promise<Frame> {
  return waitFrame(captured, (frame) => frame.type === "event" && frame.name === name && (payloadMatch === undefined || payloadMatch(frame.payload)));
}

export interface ScriptWorker {
  input: FakeInput;
  captured: CapturedWriter;
  agentDir: string;
  sessionsRoot: string;
  send(cmd: unknown): void;
  exited: Promise<void>;
}

export interface SpawnOptions {
  script?: readonly ScriptStep[];
  env?: Record<string, string | undefined>;
}

/** 内嵌 worker：temp agentDir + script 模式 env + 注入 IO */
export async function spawnScriptWorker(over: SpawnOptions = {}): Promise<ScriptWorker> {
  const agentDir = await mkdtemp(join(tmpdir(), "hub-worker-"));
  const sessionsRoot = join(agentDir, "sessions");
  const input = new FakeInput();
  const captured = captureWriter();
  let exitResolve: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });
  const pending = runWorker({
    agentDir,
    sessionsRoot,
    env: {
      HUB_WORKER_PROVIDER: "script",
      ...(over.script !== undefined ? { HUB_WORKER_SCRIPT: JSON.stringify(over.script) } : {}),
      ...over.env,
    },
    input: input as unknown as NodeJS.ReadStream,
    writerOverride: captured,
    exit: () => {
      exitResolve();
    },
  });
  await waitFrame(captured.lines, (frame) => frame.type === "hello");
  void pending;
  return {
    input,
    captured,
    agentDir,
    sessionsRoot,
    send: (cmd) => input.send(JSON.stringify(cmd)),
    exited,
  };
}
