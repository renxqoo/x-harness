import { statSync } from "node:fs";
import type { ProcHandle, SpawnRequest, SpawnResult } from "../types.ts";

const SETTLE_POLL_MS = 50;
const SETTLE_POLLS = 100;
const SETTLE_KILL_SIGNAL = "SIGKILL";

const liveGroups = new Set<number>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.prependListener("exit", () => {
    for (const pid of liveGroups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
      }
    }
  });
}

function killGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function settleGroup(pid: number): Promise<void> {
  for (let i = 0; i < SETTLE_POLLS; i++) {
    if (!groupAlive(pid)) {
      liveGroups.delete(pid);
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, SETTLE_POLL_MS);
    });
  }
  killGroup(pid, SETTLE_KILL_SIGNAL);
  liveGroups.delete(pid);
}

export async function spawnLocal(req: SpawnRequest): Promise<SpawnResult> {
  if (req.cwd !== undefined) {
    let dirOk = false;
    try {
      dirOk = statSync(req.cwd).isDirectory();
    } catch {
      dirOk = false;
    }
    if (!dirOk) return { ok: false, reason: { kind: "cwd_invalid", detail: `cwd is not an accessible directory: ${req.cwd}` } };
  }
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn([...req.argv], {
      ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
      ...(req.env !== undefined ? { env: req.env } : {}),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "EACCES" || code === "EPERM") return { ok: false, reason: { kind: "not_executable", detail: message } };
    if (code === "ENOENT" || message.includes("ENOENT")) return { ok: false, reason: { kind: "not_found", detail: message } };
    return { ok: false, reason: { kind: "io_error", detail: message } };
  }
  const pid = proc.pid;
  if (typeof pid !== "number" || pid <= 0) {
    return { ok: false, reason: { kind: "io_error", detail: "spawn returned no usable pid" } };
  }
  installExitHook();
  liveGroups.add(pid);

  const exited = (async (): Promise<{ code: number | null; signal: string | null }> => {
    try {
      await proc.exited;
    } catch {
      return { code: null, signal: null };
    }
    return { code: proc.exitCode ?? null, signal: proc.signalCode ?? null };
  })();
  const settled = exited.then(
    () => settleGroup(pid),
    () => settleGroup(pid),
  );

  const handle: ProcHandle = {
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    exited,
    kill: async (phase) => {
      killGroup(pid, phase === "term" ? "SIGTERM" : "SIGKILL");
    },
    settled,
  };
  return { ok: true, proc: handle };
}
