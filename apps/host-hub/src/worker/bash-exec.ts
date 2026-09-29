import { existsSync } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Session } from "@x-harness/session";
import { BASH_CONCURRENCY, BASH_OUTPUT_INLINE_CAP, BASH_OUTPUT_INLINE_RESPONSE_CAP, BASH_OUTPUT_MEMORY_CAP, FORK_GRACE_SIGTERM_MS } from "../shared/limits.ts";
import { truncateBytes } from "../shared/truncate.ts";

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

export interface InflightBashFace {
  id: string;
  command: string;
  startedAt: number;
}

export type ShellResolution = { ok: true; path: string } | { ok: false; reason: string };

export function resolveShell(env: Readonly<Record<string, string | undefined>> = process.env): ShellResolution {
  const explicit = env["HUB_BASH"];
  if (explicit !== undefined && explicit !== "") return { ok: true, path: explicit };
  for (const candidate of ["/bin/bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/sh"]) {
    if (existsSync(candidate)) return { ok: true, path: candidate };
  }
  return { ok: false, reason: "bash unavailable on this platform" };
}

const detachedPids = new Set<number>();
let sweepInstalled = false;

export function installDetachExitSweep(exitHook: (code: number) => never = (code) => process.exit(code)): void {
  if (sweepInstalled) return;
  sweepInstalled = true;
  process.on("exit", () => {
    for (const pid of detachedPids) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
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

export async function twoStageKillGroup(pid: number, graceMs = FORK_GRACE_SIGTERM_MS): Promise<void> {
  const signal = (name: "SIGTERM" | "SIGKILL"): void => {
    try {
      process.kill(-pid, name);
    } catch {
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
  confirm: (fields: { tool: string; summary: string; reason: string }, signal?: AbortSignal) => Promise<import("./dialogs.ts").ConfirmAnswer>;
  emitEvent: (name: string, payload: unknown) => void;
  agentDir: string;
  defaultTimeoutMs: number;
  onStateChange: () => void;
  killGraceMs?: number;
  shell?: ShellResolution;
}

interface RunningBash {
  controller: AbortController;
  startedAt: number;
  command: string;
}

export function createBashExec(deps: BashExecDeps) {
  const running = new Map<string, RunningBash>();
  const admissionAborts = new Set<() => void>();

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
      await agent.flush();
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
    const path = join(dir, `${seq}.${encodeURIComponent(key).replaceAll("%", "_")}.${randomUUID().slice(0, 8)}.txt`);
    await writeFile(path, output, "utf8");
    return path;
  }

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
      cancelSignal.abort();
    };
    admissionAborts.add(onAdmissionAbort);
    let approved: boolean;
    try {
      const answer = await Promise.race([
        deps.confirm({ tool: "bash", summary: request.command, reason: "direct execution requested by client" }, cancelSignal.signal),
        cancelled.then((): null => null),
      ]);
      approved = answer !== null && answer.allowed;
    } finally {
      admissionAborts.delete(onAdmissionAbort);
    }
    if (!approved) {
      releaseClaim(key);
      return { ok: false, reason: cancelSignal.signal.aborted ? "aborted before execution started" : "permission denied" };
    }
    const entry = running.get(key);
    const controller = entry?.controller ?? new AbortController();
    if (entry !== undefined) entry.startedAt = Date.now();
    deps.onStateChange();
    return { ok: true, controller };
  }

  function releaseClaim(key: string): void {
    running.delete(key);
    deps.onStateChange();
  }

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
            detached: true,
          });
        } catch (error) {
          reject(new Error(String(error instanceof Error ? error.message : error)));
          return;
        }
        const pid = child.pid;
        trackDetached(pid);
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
                truncated: truncated || inline.truncated,
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
    readLatest(): InflightBashFace | null {
      let latest: InflightBashFace | null = null;
      for (const [id, entry] of running) {
        latest = { id, command: entry.command, startedAt: entry.startedAt };
      }
      return latest;
    },
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
        const shell = deps.shell ?? resolveShell();
        if (!shell.ok) return { ok: false, reason: shell.reason };
        const slot = claimSlot(request.id, request.command);
        if (!slot.ok) return { ok: false, reason: slot.reason };
        deps.onStateChange();
        const admission = await admit(request, slot.key);
        if (!admission.ok) return { ok: false, reason: admission.reason };
        return await runCommand({ request, key: slot.key, controller: admission.controller, shellPath: shell.path });
      } catch (error) {
        return { ok: false, reason: String(error instanceof Error ? error.message : error) };
      }
    },
  };
}

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
