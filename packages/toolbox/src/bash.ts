// bash 工具（docs/TOOLBOX.md §4 + docs/EXEC-ENV.md §3/§6）：进程生命周期经 env.spawn
// （detached 组杀/settle 观测面/host-exit 清场——全在 exec-env；本文件只留两段杀节奏策略）；
// 双流全程并发消费；截断保尾+spill（0700/wx 0600/随机名）；退出码非 isError；
// needs_network 声明位（permission 裁决依据——声明走 ask，未声明撞断网自行回头）。

import { mkdirSync, mkdtempSync, openSync, closeSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolExecContext } from "@x-harness/tools";
import type { ExecEnv, ProcHandle } from "@x-harness/exec-env";
import { PathGate } from "./paths.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_BYTES = 30_000;
const OUTPUT_LINE_CAP = 2_000;
const KILL_GRACE_MS = 5_000;

/** POSIX 信号→编号（128+n 渲染——env 层 code null + signal，折算属本层） */
const SIGNAL_NUM: Readonly<Record<string, number>> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8,
  SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
  SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22,
};

export interface BashLimits {
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly spillDir: string;
}

export function defaultLimits(over: { defaultTimeoutMs?: number; maxTimeoutMs?: number; maxOutputBytes?: number; spillDir?: string } = {}): BashLimits {
  const defaultTimeoutMs = over.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = over.maxTimeoutMs ?? MAX_TIMEOUT_MS;
  if (defaultTimeoutMs > maxTimeoutMs) throw new Error("toolbox: defaultTimeoutMs must not exceed maxTimeoutMs");
  return {
    defaultTimeoutMs,
    maxTimeoutMs,
    maxOutputBytes: over.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES,
    spillDir: over.spillDir ?? mkdtempSync(join(tmpdir(), "x-harness-")),
  };
}

export function createBashTool(gate: PathGate, limits: BashLimits, env: ExecEnv): ToolDefinition {
  return {
    name: "bash",
    description:
      "Run a shell command with /bin/sh -c in the workspace root (workdir optional, must stay inside the root). Non-zero exit codes are shown as [exit code: N] and are NOT tool errors — inspect the output. Long-running commands (builds, installs) should pass timeout_ms explicitly (default 120000ms, max 600000ms). Commands needing network access (installs, fetches) must declare needs_network:true. Output is truncated to the last 30000 bytes with the full output written to a spill file.",
    inputSchema: Type.Object({
      command: Type.String({ description: "Shell command line" }),
      timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_MS, description: `Wall-clock timeout in ms (default ${String(DEFAULT_TIMEOUT_MS)}, max ${String(MAX_TIMEOUT_MS)})` })),
      workdir: Type.Optional(Type.String({ description: "Working directory (inside workspace root; default root)" })),
      needs_network: Type.Optional(Type.Boolean({ description: "Declare that this command requires network access — routes through approval before running" })),
    }),
    execute: async (args, ctx: ToolExecContext) => bash({ gate, limits, env, ctx, args: args as { command: string; timeout_ms?: number; workdir?: string; needs_network?: boolean } }),
  };
}

async function bash(input: {
  readonly gate: PathGate;
  readonly limits: BashLimits;
  readonly env: ExecEnv;
  readonly ctx: ToolExecContext;
  readonly args: { command: string; timeout_ms?: number; workdir?: string; needs_network?: boolean };
}): Promise<{ content: string; isError?: true }> {
  const { gate, limits, env, ctx, args } = input;
  void args.needs_network; // 声明位由 permission 在 pre-execute 裁决——执行层不消费
  if (PathGate.hasNul(args.command) || (args.workdir !== undefined && PathGate.hasNul(args.workdir))) {
    return { content: "NUL_IN_ARGUMENT: command/workdir contains NUL", isError: true };
  }
  let cwd = gate.root;
  if (args.workdir !== undefined) {
    const admitted = await gate.admit(args.workdir, env.realpath);
    if (!admitted.ok) return { content: admitted.reason, isError: true };
    const st = await env.stat(admitted.path);
    if (!st.ok) return { content: `WORKDIR_NOT_FOUND: ${args.workdir} does not exist`, isError: true };
    if (st.stat.kind !== "dir") return { content: `WORKDIR_NOT_DIRECTORY: ${args.workdir} is not a directory`, isError: true };
    cwd = admitted.path;
  }
  if (ctx.signal.aborted) return { content: "aborted: tool call aborted before dispatch", isError: true }; // pre-abort 零 spawn

  const timeoutMs = Math.min(args.timeout_ms ?? limits.defaultTimeoutMs, limits.maxTimeoutMs); // 运行时复检（schema 上限可被配置收紧）
  return render(await runCommand({ command: args.command, cwd, timeoutMs, limits, env, ctx }));
}

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timeoutMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly spawnError: string | undefined;
  readonly spillPath: string | undefined;
  readonly truncated: boolean;
}

async function runCommand(input: { readonly command: string; readonly cwd: string; readonly timeoutMs: number; readonly limits: BashLimits; readonly env: ExecEnv; readonly ctx: ToolExecContext }): Promise<RunResult> {
  const { command, cwd, timeoutMs, limits, env, ctx } = input;
  const out = new ChannelCollector();
  const err = new ChannelCollector();
  const spawned = await env.spawn({ argv: ["/bin/sh", "-c", command], cwd, ...(ctx.session !== undefined ? { session: ctx.session } : {}) });
  if (!spawned.ok) {
    return { stdout: "", stderr: "", exitCode: null, timeoutMs, timedOut: false, aborted: false, spawnError: `${spawned.reason.kind}: ${spawned.reason.detail}`, spillPath: undefined, truncated: false };
  }
  const proc: ProcHandle = spawned.proc;
  let timedOut = false;
  const wall = setTimeout(() => {
    timedOut = true;
    void proc.kill("term");
  }, timeoutMs);
  // KILL 升级在组级：组长先退 ≠ 组清空——env.settled 是死净观测面，升级定时器只在死净后清理
  const killUpgrade = setTimeout(() => {
    void proc.kill("kill");
  }, timeoutMs + KILL_GRACE_MS);
  let abortUpgrade: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    void proc.kill("term");
    abortUpgrade = setTimeout(() => void proc.kill("kill"), KILL_GRACE_MS);
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  proc.settled.then(() => {
    clearTimeout(killUpgrade);
    if (abortUpgrade !== undefined) clearTimeout(abortUpgrade);
  });

  const pumps = [pump(proc.stdout, out), pump(proc.stderr, err)];
  const exited = await proc.exited;
  await Promise.allSettled(pumps);
  clearTimeout(wall);
  ctx.signal.removeEventListener("abort", onAbort);
  await proc.settled; // 孙进程收敛（组长退出≠组清空——有界 5s 兜底 KILL 在 env）
  // 先结算（truncated 标志在 text() 内置位）再决定 spill——顺序反了会漏 spill
  const stdoutText = out.text(limits.maxOutputBytes);
  const stderrText = err.text(limits.maxOutputBytes);
  const truncated = out.truncated || err.truncated;
  const spillPath = truncated ? writeSpill(limits, `${out.full}${err.full === "" ? "" : `\n[stderr]\n${err.full}`}`) : undefined;
  return {
    stdout: stdoutText,
    stderr: stderrText,
    exitCode: renderableCode(exited),
    timeoutMs,
    timedOut,
    aborted: ctx.signal.aborted,
    spawnError: undefined,
    spillPath,
    truncated: out.truncated || err.truncated,
  };
}

/** 信号死亡 → 128+n（exit code 文案口径；正常退出直取 code） */
function renderableCode(exited: { readonly code: number | null; readonly signal: string | null }): number | null {
  if (exited.code !== null) return exited.code;
  if (exited.signal !== null) return 128 + (SIGNAL_NUM[exited.signal] ?? 0);
  return null;
}

/** 字节精确取尾：起始位置若落在 UTF-8 续字节（0b10xxxxxx）则前移到字符边界——
 *  不撕裂多字节字符、必有推进（对比字符数切片：≥3 字节/字符的输出会使切片成为无进展空转） */
function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  let start = buf.byteLength - maxBytes;
  while (start > 0 && ((buf[start] as number) & 0xc0) === 0x80) start -= 1;
  return buf.subarray(start).toString("utf8");
}

/** 双流全程并发消费：即使截断/spill 失败也读到 EOF 丢弃（防子进程堵管假挂） */
async function pump(stream: ReadableStream<Uint8Array>, collector: ChannelCollector): Promise<void> {
  const reader = stream.getReader();
  const decoder = new StringDecoder("utf8");
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    collector.push(decoder.write(read.value)); // StringDecoder：跨 chunk 撕裂 UTF-8 不出替换符
  }
  collector.push(decoder.end());
}

const FULL_CAP_BYTES = 64 * 1024 * 1024;

class ChannelCollector {
  private readonly parts: string[] = [];
  full = "";
  fullBytes = 0;
  fullCapped = false;
  truncated = false;

  push(text: string): void {
    if (text === "" || this.fullCapped) return;
    this.parts.push(text);
    this.full += text;
    this.fullBytes += Buffer.byteLength(text);
    if (this.fullBytes > FULL_CAP_BYTES) {
      this.fullCapped = true; // spill 体量上限：停止累积（内存 DoS 防护）
      this.full = this.full.slice(0, FULL_CAP_BYTES * 2);
    }
  }

  /** 截断保尾部（完整行边界起，单行超帽允许行中截）+ 行数帽；字节精确取尾不越 30KB 口径 */
  text(maxBytes: number): string {
    let joined = this.parts.join("");
    if (Buffer.byteLength(joined) > maxBytes) {
      this.truncated = true;
      joined = tailBytes(joined, maxBytes);
      const nl = joined.indexOf("\n");
      joined = nl >= 0 && Buffer.byteLength(joined) - Buffer.byteLength(joined.slice(nl + 1)) < maxBytes
        ? joined.slice(nl + 1) // 从完整行边界起（行内剩余仍 ≤ 帽）
        : joined; // 单行超帽：行中截（保尾部优先于行完整）
    }
    const lines = joined.split("\n");
    const counted = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    if (counted > OUTPUT_LINE_CAP) {
      this.truncated = true;
      joined = lines.slice(-OUTPUT_LINE_CAP).join("\n");
    }
    return cleanAnsi(joined);
  }
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"); // ESC[ 序列（ANSI CSI）
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, "g"); // ESC]...BEL OSC 序列
const CR_RE = new RegExp("\\r(?!\\n)", "g"); // 裸 \r（非 CRLF）

/** ANSI 转义与裸 \r 清洗（token 噪声；锚定 ESC——普通 [word] 文本不受影响） */
function cleanAnsi(text: string): string {
  return text.replace(CSI_RE, "").replace(OSC_RE, "").replace(CR_RE, "");
}

function writeSpill(limits: BashLimits, full: string): string | undefined {
  try {
    mkdirSync(limits.spillDir, { recursive: true, mode: 0o700 });
    const path = join(limits.spillDir, `bash-${randomBytes(8).toString("hex")}.txt`);
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, full);
    } finally {
      closeSync(fd);
    }
    return path;
  } catch {
    return undefined;
  }
}

function render(result: RunResult): { content: string; isError?: true } {
  if (result.spawnError !== undefined) {
    return { content: `SPAWN_FAILED: ${result.spawnError}`, isError: true };
  }
  const sections: string[] = [];
  if (result.stdout !== "") sections.push(result.stdout);
  if (result.stderr !== "") sections.push(`[stderr]\n${result.stderr}`);
  let body = sections.length === 0 ? "(no output)" : sections.join("\n");
  if (result.timedOut) {
    body = `[timed out after ${String(result.timeoutMs)}ms]${result.aborted ? " (aborted)" : " — raise timeout_ms and retry if this command legitimately needs longer"}\n${body}`;
  } else if (result.aborted) {
    body = `[aborted]\n${body}`;
  }
  if (result.exitCode !== null && !result.timedOut && !result.aborted) {
    body = `${body}${body === "" || body.endsWith("\n") ? "" : "\n"}[exit code: ${String(result.exitCode)}]`;
  }
  if (result.spillPath !== undefined) {
    body = `[output truncated; full output: ${result.spillPath}]\n${body}`;
  } else if (result.truncated) {
    body = `[output truncated; full output unavailable]\n${body}`;
  }
  return { content: body };
}

export { KILL_GRACE_MS, OUTPUT_LINE_CAP, DEFAULT_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
