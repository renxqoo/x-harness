// bash 工具（docs/TOOLBOX.md §4）：detached 进程组 + 手动负 pid 两段杀；host-exit 清场登记簿；
// 双流全程并发消费；截断保尾+spill（mkdtemp 0700、wx 0600、随机名无用户成分）；退出码非 isError。

import { mkdirSync, mkdtempSync, openSync, closeSync, writeSync, statSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolExecContext } from "@x-harness/tools";
import { PathGate } from "./paths.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_BYTES = 30_000;
const OUTPUT_LINE_CAP = 2_000;
const KILL_GRACE_MS = 5_000;

/** 活组登记簿 + host-exit 清场（exit handler 仅同步操作） */
const liveGroups = new Set<number>();
process.prependListener("exit", () => {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* 组已亡 */
    }
  }
});

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

export function createBashTool(gate: PathGate, limits: BashLimits): ToolDefinition {
  return {
    name: "bash",
    description:
      "Run a shell command with /bin/sh -c in the workspace root (workdir optional, must stay inside the root). Non-zero exit codes are shown as [exit code: N] and are NOT tool errors — inspect the output. Long-running commands (builds, installs) should pass timeout_ms explicitly (default 120000ms, max 600000ms). Output is truncated to the last 30000 bytes with the full output written to a spill file.",
    inputSchema: Type.Object({
      command: Type.String({ description: "Shell command line" }),
      timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_MS, description: `Wall-clock timeout in ms (default ${String(DEFAULT_TIMEOUT_MS)}, max ${String(MAX_TIMEOUT_MS)})` })),
      workdir: Type.Optional(Type.String({ description: "Working directory (inside workspace root; default root)" })),
    }),
    execute: async (args, ctx: ToolExecContext) => bash({ gate, limits, ctx, args: args as { command: string; timeout_ms?: number; workdir?: string } }),
  };
}

async function bash(input: { readonly gate: PathGate; readonly limits: BashLimits; readonly ctx: ToolExecContext; readonly args: { command: string; timeout_ms?: number; workdir?: string } }): Promise<{ content: string; isError?: true }> {
  const { gate, limits, ctx, args } = input;
  if (PathGate.hasNul(args.command) || (args.workdir !== undefined && PathGate.hasNul(args.workdir))) {
    return { content: "NUL_IN_ARGUMENT: command/workdir contains NUL", isError: true };
  }
  let cwd = gate.root;
  if (args.workdir !== undefined) {
    const admitted = gate.admit(args.workdir);
    if (!admitted.ok) return { content: admitted.reason, isError: true };
    let st: Stats;
    try {
      st = statSync(admitted.path);
    } catch {
      return { content: `WORKDIR_NOT_FOUND: ${args.workdir} does not exist`, isError: true };
    }
    if (!st.isDirectory()) return { content: `WORKDIR_NOT_DIRECTORY: ${args.workdir} is not a directory`, isError: true };
    cwd = admitted.path;
  }

  const timeoutMs = Math.min(args.timeout_ms ?? limits.defaultTimeoutMs, limits.maxTimeoutMs); // 运行时复检（schema 上限可被配置收紧）
  return render(await runCommand({ command: args.command, cwd, timeoutMs, limits, ctx }));
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

async function runCommand(input: { readonly command: string; readonly cwd: string; readonly timeoutMs: number; readonly limits: BashLimits; readonly ctx: ToolExecContext }): Promise<RunResult> {
  const { command, cwd, timeoutMs, limits, ctx } = input;
  const out = new ChannelCollector();
  const err = new ChannelCollector();
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(["/bin/sh", "-c", command], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  } catch (error) {
    return { stdout: "", stderr: "", exitCode: null, timeoutMs, timedOut: false, aborted: false, spawnError: error instanceof Error ? error.message : String(error), spillPath: undefined, truncated: false };
  }
  const pid = proc.pid;
  liveGroups.add(pid);
  let timedOut = false;
  const wall = setTimeout(() => {
    timedOut = true;
    killGroup(pid, "SIGTERM");
  }, timeoutMs);
  // KILL 升级在组级：组长先退 ≠ 组清空——升级定时器只在组探活确认死净后才清理
  const killUpgrade = setTimeout(() => {
    killGroup(pid, "SIGKILL");
  }, timeoutMs + KILL_GRACE_MS);
  let abortUpgrade: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    killGroup(pid, "SIGTERM");
    abortUpgrade = setTimeout(() => killGroup(pid, "SIGKILL"), KILL_GRACE_MS);
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  const pumps = [pump(proc.stdout as ReadableStream<Uint8Array>, out), pump(proc.stderr as ReadableStream<Uint8Array>, err)];
  let exitCode: number | null = null;
  try {
    exitCode = (await proc.exited) as number;
  } catch {
    exitCode = null;
  }
  await Promise.allSettled(pumps);
  clearTimeout(wall);
  ctx.signal.removeEventListener("abort", onAbort);
  if (abortUpgrade !== undefined) clearTimeout(abortUpgrade);
  // 组探活：孙进程可能仍活（组长退出≠组清空）——活则等净再除名与撤 KILL
  await settleGroup(pid, killUpgrade);
  // 先结算（truncated 标志在 text() 内置位）再决定 spill——顺序反了会漏 spill
  const stdoutText = out.text(limits.maxOutputBytes);
  const stderrText = err.text(limits.maxOutputBytes);
  const truncated = out.truncated || err.truncated;
  const spillPath = truncated ? writeSpill(limits, `${out.full}${err.full === "" ? "" : `\n[stderr]\n${err.full}`}`) : undefined;
  return {
    stdout: stdoutText,
    stderr: stderrText,
    exitCode,
    timeoutMs,
    timedOut,
    aborted: ctx.signal.aborted,
    spawnError: undefined,
    spillPath,
    truncated: out.truncated || err.truncated,
  };
}

function killGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* 组已不存在 */
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0); // 组探活：0 信号不杀只探测
    return true;
  } catch {
    return false;
  }
}

/** 组清零收敛：组长退出后孙进程可能仍活——有界轮询（50ms×100=5s 上限）探活；
 *  一直活到上限则发 SIGKILL 兜底后除名（host-exit 清场不再兜底——这里是最后防线） */
async function settleGroup(pid: number, killUpgrade: ReturnType<typeof setTimeout>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (!groupAlive(pid)) {
      clearTimeout(killUpgrade);
      liveGroups.delete(pid);
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  killGroup(pid, "SIGKILL");
  clearTimeout(killUpgrade);
  liveGroups.delete(pid);
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

/** 字节精确取尾：起始位置若落在 UTF-8 续字节（0b10xxxxxx）则前移到字符边界——
 *  不撕裂多字节字符、必有推进（对比字符数切片：≥3 字节/字符的输出会使切片成为无进展空转） */
function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  let start = buf.byteLength - maxBytes;
  while (start > 0 && ((buf[start] as number) & 0xc0) === 0x80) start -= 1; // start < byteLength 恒真——索引必在界内
  return buf.subarray(start).toString("utf8");
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
