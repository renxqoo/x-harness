// 直执行 bash（DESIGN §3.7）：同步认领槽位（检查与占位同拍——弹窗期不可重复
// 认领；满 8 拒不逐出；无 id 并发拒；id 重复拒；确认拒绝/准入取消时释放占位）→
// DialogBroker confirm（超时默认拒绝）vs abort_bash 竞速（败者帧压掉，恰一
// 响应）→ Bun.spawn detached 进程组 per-command 执行（流式 bash_execution_update
// 事件；truncated 粘滞；内存 8MiB 封顶）→ per-command AbortController 墙钟 →
// 默认 user/message 信封落会话 + flush。进程树处置自实现（detached 进程组 +
// SIGTERM 宽限 → SIGKILL；exit sweep 兜底暴毙路径）。admission 按 worker 域键控。
// 溢写 <agentDir>/bash-outputs/<seq>.txt（seq = 会话事件日志尾 seq）；启动清扫超
// 7 天溢写文件（cleanupBashOutputs）。
import { existsSync } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Session } from "@x-harness/session";
import { BASH_CONCURRENCY, BASH_OUTPUT_INLINE_CAP, BASH_OUTPUT_INLINE_RESPONSE_CAP, BASH_OUTPUT_MEMORY_CAP, FORK_GRACE_SIGTERM_MS } from "../shared/limits.ts";
import { truncateBytes } from "../shared/truncate.ts";

/** 溢写文件保留期（启动清扫判据） */
export const BASH_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface BashRequest {
  command: string;
  timeoutMs?: number;
  excludeFromContext?: boolean;
  id?: string;
}

export type BashOutcome =
  | { ok: true; output: string; exitCode: number; cancelled: boolean; truncated: boolean; fullOutputPath?: string }
  | { ok: false; reason: string };

/** get_inflight bash 面：最新仍在跑的直执行（单面读口——null ⇔ 无在跑） */
export interface InflightBashFace {
  id: string;
  command: string;
  startedAt: number;
}

/** shell 解析（词法单点）：HUB_BASH > /bin/bash > /bin/sh；win32 无直执行面 */
export type ShellResolution = { ok: true; path: string } | { ok: false; reason: string };

export function resolveShell(env: Readonly<Record<string, string | undefined>> = process.env): ShellResolution {
  const explicit = env["HUB_BASH"];
  if (explicit !== undefined && explicit !== "") return { ok: true, path: explicit };
  for (const candidate of ["/bin/bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/sh"]) {
    if (existsSync(candidate)) return { ok: true, path: candidate };
  }
  return { ok: false, reason: "bash unavailable on this platform" };
}

/** detached 进程登记簿（exit sweep 兜底暴毙路径——幂等安装一次） */
const detachedPids = new Set<number>();
let sweepInstalled = false;

export function installDetachExitSweep(exitHook: (code: number) => never = (code) => process.exit(code)): void {
  if (sweepInstalled) return;
  sweepInstalled = true;
  process.on("exit", () => {
    for (const pid of detachedPids) {
      try {
        process.kill(-pid, "SIGKILL"); // 进程组兜底（可能已死——ENOENT 吞）
      } catch {
        // 已退出/不可杀：登记簿随进程消亡
      }
    }
  });
  void exitHook;
}

function trackDetached(pid: number): void {
  detachedPids.add(pid);
}

function untrackDetached(pid: number): void {
  detachedPids.delete(pid);
}

/** 进程组两段杀：SIGTERM 宽限后 SIGKILL（无条件腿兜孙进程） */
export async function twoStageKillGroup(pid: number, graceMs = FORK_GRACE_SIGTERM_MS): Promise<void> {
  const signal = (name: "SIGTERM" | "SIGKILL"): void => {
    try {
      process.kill(-pid, name); // 负 pid = 进程组（spawn detached 成立）
    } catch {
      // 组已消亡：本级吞（SIGHUP 孤儿自理）
    }
  };
  signal("SIGTERM");
  await new Promise<void>((resolve) => {
    setTimeout(resolve, graceMs);
  });
  signal("SIGKILL");
}

export interface BashExecDeps {
  session: () => { session: Session; flush: () => Promise<unknown> } | undefined;
  cwd: () => string;
  confirm: (fields: { tool: string; summary: string; reason: string }, signal?: AbortSignal) => Promise<boolean>;
  emitEvent: (name: string, payload: unknown) => void;
  agentDir: string;
  defaultTimeoutMs: number;
  /** 槽位状态外部化（get_inflight bash 面与 busy 谓词消耗） */
  onStateChange: () => void;
  /** 组杀宽限（测试注入） */
  killGraceMs?: number;
  /** shell 解析注入（测试） */
  shell?: ShellResolution;
}

interface RunningBash {
  controller: AbortController;
  startedAt: number;
  command: string;
}

/** worker 域的直执行面：admission 表 + abort 句柄（域键控不随会话换绑漂移） */
export function createBashExec(deps: BashExecDeps) {
  const running = new Map<string, RunningBash>();
  /** 弹窗期准入取消句柄（abort_bash 在执行前到达时结算） */
  const admissionAborts = new Set<() => void>();

  /** 认领即占位（同步）：弹窗等待期占位可见——重复 id/满表在弹窗前即拒 */
  function claimSlot(rawId: string | undefined, command: string): { ok: true; key: string } | { ok: false; reason: string } {
    const key = rawId ?? "";
    if (key === "" && running.has("")) {
      return { ok: false, reason: "concurrent direct bash requires a command id" };
    }
    if (key !== "" && running.has(key)) {
      return { ok: false, reason: "bash command id is already in use" };
    }
    if (running.size >= BASH_CONCURRENCY) {
      return { ok: false, reason: "too many concurrent direct bash executions (limit reached)" };
    }
    running.set(key, { controller: new AbortController(), startedAt: Date.now(), command });
    return { ok: true, key };
  }

  async function appendEnvelope(command: string, output: string): Promise<void> {
    const agent = deps.session();
    if (agent === undefined) return;
    const append = agent.session.append(
      "user/message",
      { turn: 0, step: 0, content: [{ type: "text", text: `[bash] $ ${command}\n${output}` }] },
      { surfaceOp: "append" },
    );
    if (!append.ok) {
      process.stderr.write(`hub:worker: bash envelope append failed: ${append.reason}\n`);
      return;
    }
    try {
      await agent.flush(); // 直写纪律：空闲期 append 不 flush 即崩溃丢失
    } catch (error) {
      process.stderr.write(`hub:worker: bash envelope flush failed: ${String(error)}\n`);
    }
  }

  async function spill(output: string, key: string): Promise<string | undefined> {
    if (Buffer.byteLength(output, "utf8") <= BASH_OUTPUT_INLINE_CAP) return undefined;
    const agent = deps.session();
    const seq = agent !== undefined ? agent.session.events().length - 1 : Date.now();
    const dir = join(deps.agentDir, "bash-outputs");
    await mkdir(dir, { recursive: true });
    // 文件名并入命令 key + 随机后缀——并发命令同 seq 不互相覆写
    const path = join(dir, `${seq}.${encodeURIComponent(key).replaceAll("%", "_")}.${randomUUID().slice(0, 8)}.txt`);
    await writeFile(path, output, "utf8");
    return path;
  }

  /** 入参校验（单点）：命令非空 + timeoutMs 正整数 ≤ 24h（0=关） */
  function validateRequest(request: BashRequest): { ok: true } | { ok: false; reason: string } {
    if (typeof request.command !== "string" || request.command.trim() === "") {
      return { ok: false, reason: "invalid command: required" };
    }
    if (
      request.timeoutMs !== undefined &&
      (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 0 || request.timeoutMs > 86_400_000)
    ) {
      return { ok: false, reason: `invalid timeoutMs: ${String(request.timeoutMs)}` };
    }
    return { ok: true };
  }

  /** 弹窗期准入：abort 穿透/拒绝时释放占位并按失败结算；通过则复用占位 controller。
   *  穿透 = 与 confirm 竞速（abort_bash 即时结算——不等弹窗超时；孤儿弹窗由
   *  broker 按未应答结算） */
  async function admit(request: BashRequest, key: string): Promise<{ ok: true; controller: AbortController } | { ok: false; reason: string }> {
    const cancelSignal = new AbortController();
    let cancelAdmission: () => void = () => {};
    const cancelled = new Promise<false>((resolve) => {
      cancelAdmission = () => {
        resolve(false);
      };
    });
    const onAdmissionAbort = (): void => {
      cancelAdmission();
      cancelSignal.abort(); // 孤儿弹窗即时结算（不挂 5min 超时占 busy 面）
    };
    admissionAborts.add(onAdmissionAbort);
    let approved: boolean;
    try {
      approved = await Promise.race([
        deps.confirm({ tool: "bash", summary: request.command, reason: "direct execution requested by client" }, cancelSignal.signal),
        cancelled,
      ]);
    } finally {
      admissionAborts.delete(onAdmissionAbort);
    }
    if (!approved) {
      releaseClaim(key);
      return { ok: false, reason: cancelSignal.signal.aborted ? "aborted before execution started" : "permission denied" };
    }
    const entry = running.get(key);
    const controller = entry?.controller ?? new AbortController();
    if (entry !== undefined) entry.startedAt = Date.now(); // 真执行起点（占位期不计）
    deps.onStateChange();
    return { ok: true, controller };
  }

  /** 占位释放（弹窗拒绝/准入取消/执行收尾） */
  function releaseClaim(key: string): void {
    running.delete(key);
    deps.onStateChange();
  }

  /** 执行段：per-command 墙钟 + detached 组杀 + 流式事件 + 输出封顶/溢写/信封 */
  async function runCommand(fields: { request: BashRequest; key: string; controller: AbortController; shellPath: string }): Promise<BashOutcome> {
    const { request, key, controller, shellPath } = fields;
    const effectiveTimeout = request.timeoutMs ?? deps.defaultTimeoutMs;
    const graceMs = deps.killGraceMs ?? FORK_GRACE_SIGTERM_MS;
    const timer = effectiveTimeout > 0 ? setTimeout(() => controller.abort(), effectiveTimeout) : undefined;
    try {
      return await new Promise<BashOutcome>((resolve, reject) => {
        let child: ReturnType<typeof Bun.spawn>;
        try {
          child = Bun.spawn([shellPath, "-c", request.command], {
            cwd: deps.cwd(),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            detached: true, // 进程组成立（组杀面 = -pid）
          });
        } catch (error) {
          // 真 spawn 失败（ENOENT/EMFILE/cwd 缺席）——错误终态应答（恰一响应不悬挂）
          reject(new Error(String(error instanceof Error ? error.message : error)));
          return;
        }
        const pid = child.pid;
        trackDetached(pid);
        // abort/timeout 组杀（两段）：fire-and-forget——停机路径由登记簿清场与 exit
        // sweep 兜底闭环。注册时初查：abort 早于 spawn 到达不漏杀
        const killNow = (): void => {
          if (pid !== undefined) void twoStageKillGroup(pid, graceMs);
        };
        if (controller.signal.aborted) killNow();
        else
          controller.signal.addEventListener(
            "abort",
            () => {
              killNow();
            },
            { once: true },
          );
        let output = "";
        let truncated = false;
        const decoder = new TextDecoder();
        const push = (chunk: string): void => {
          output += chunk;
          const bounded = truncateBytes(output, BASH_OUTPUT_MEMORY_CAP);
          if (bounded.truncated) {
            output = bounded.text;
            truncated = true;
          }
          deps.emitEvent("bash_execution_update", {
            id: key,
            delta: chunk,
            ...(truncated ? { truncated: true } : {}),
          });
        };
        const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
          for await (const chunk of stream) push(decoder.decode(chunk, { stream: true }));
        };
        void pump(child.stdout as ReadableStream<Uint8Array>).catch(() => undefined);
        void pump(child.stderr as ReadableStream<Uint8Array>).catch(() => undefined);
        void child.exited.then((code) => {
          untrackDetached(pid);
          const cancelled = controller.signal.aborted;
          if (!request.excludeFromContext) void appendEnvelope(request.command, output);
          void spill(output, key).then(
            (fullOutputPath) => {
              const inline = truncateBytes(output, BASH_OUTPUT_INLINE_RESPONSE_CAP);
              resolve({
                ok: true,
                output: inline.text,
                exitCode: code ?? -1,
                cancelled,
                truncated: truncated || inline.truncated, // 64KiB 内联截断同样标记（不静默切尾）
                ...(fullOutputPath !== undefined ? { fullOutputPath } : {}),
              });
            },
            () => {
              const inline = truncateBytes(output, BASH_OUTPUT_INLINE_RESPONSE_CAP);
              resolve({ ok: true, output: inline.text, exitCode: code ?? -1, cancelled, truncated: truncated || inline.truncated });
            },
          );
        });
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      releaseClaim(key);
    }
  }

  return {
    runningCount: () => running.size,
    isRunning: () => running.size > 0,
    /** get_inflight bash 读口：最新仍在跑者（Map 迭代序 = 写入序；null ⇔ 无在跑） */
    readLatest(): InflightBashFace | null {
      let latest: InflightBashFace | null = null;
      for (const [id, entry] of running) {
        latest = { id, command: entry.command, startedAt: entry.startedAt };
      }
      return latest;
    },
    /** 弹窗期到达的 abort：取消挂起准入（弹窗按未应答结算、命令不执行） */
    abortAdmissions(): boolean {
      const had = admissionAborts.size > 0;
      for (const abort of admissionAborts) abort();
      admissionAborts.clear();
      return had;
    },
    abortRunning(rawId: string | undefined): void {
      if (rawId !== undefined && rawId !== "" && running.has(rawId)) {
        running.get(rawId)?.controller.abort();
        return;
      }
      for (const entry of running.values()) entry.controller.abort();
    },
    async exec(request: BashRequest): Promise<BashOutcome> {
      try {
        const verdict = validateRequest(request);
        if (!verdict.ok) return { ok: false, reason: verdict.reason };
        // shell 解析钉在 claimSlot 前：零副作用、不占并发额度、不弹废窗
        const shell = deps.shell ?? resolveShell();
        if (!shell.ok) return { ok: false, reason: shell.reason };
        const slot = claimSlot(request.id, request.command);
        if (!slot.ok) return { ok: false, reason: slot.reason };
        deps.onStateChange();
        const admission = await admit(request, slot.key);
        if (!admission.ok) return { ok: false, reason: admission.reason };
        return await runCommand({ request, key: slot.key, controller: admission.controller, shellPath: shell.path });
      } catch (error) {
        // 执行器异常终态（spawn 同步抛错等）——错误面应答不悬挂（恰一响应）
        return { ok: false, reason: String(error instanceof Error ? error.message : error) };
      }
    },
  };
}

/** 启动清扫：bash-outputs 超保留期的溢写文件（随会话删除不保证发生——兜底回收） */
export async function cleanupBashOutputs(agentDir: string): Promise<void> {
  const dir = join(agentDir, "bash-outputs");
  const names = await readdir(dir).catch(() => undefined);
  if (names === undefined) return;
  const cutoff = Date.now() - BASH_OUTPUT_RETENTION_MS;
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || !info.isFile()) continue;
    if (info.mtimeMs < cutoff) await unlink(path).catch(() => undefined);
  }
}

export type BashExec = ReturnType<typeof createBashExec>;
