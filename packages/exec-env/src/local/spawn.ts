// spawn 契约实现（docs/EXEC-ENV.md §1/§2）：detached 进程组 + 负 pid 组杀 + host-exit 进程级单例清场
// + settle 观测面（组长退出≠组清空——孙进程有界收敛 5s 后 SIGKILL 兜底）。语义自 toolbox bash.ts 迁移。
// 两段杀的节奏（何时 TERM/何时 KILL）是策略，归 bash 工具；本模块只提供动作与观测。

import type { ProcHandle, SpawnRequest, SpawnResult } from "../types.ts";

/** settle 收敛上限：50ms×100=5s；到顶仍活 → SIGKILL 兜底后除名（host-exit 不再兜底——最后防线） */
const SETTLE_POLL_MS = 50;
const SETTLE_POLLS = 100;
const SETTLE_KILL_SIGNAL = "SIGKILL";

/** 进程级单例登记簿 + host-exit 清场（exit handler 仅同步操作；模块存活期不注销——quiescence 语义） */
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
        /* 组已死 */
      }
    }
  });
}

function killGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* 组已不存在——幂等 */
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0); // 0 信号只探测不杀
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
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn([...req.argv], {
      ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) return { ok: false, reason: { kind: "not_found", detail: message } };
    if (message.includes("EACCES") || message.includes("EPERM")) return { ok: false, reason: { kind: "not_executable", detail: message } };
    return { ok: false, reason: { kind: "io_error", detail: message } };
  }
  const pid = proc.pid ?? -1;
  installExitHook();
  liveGroups.add(pid);

  const exited = (async (): Promise<{ code: number | null; signal: string | null }> => {
    await proc.exited;
    return { code: proc.exitCode ?? null, signal: proc.signalCode ?? null };
  })();
  // settle 在组长退出即启动（不等消费方 await）——孙进程收敛不等位于策略层
  const settled = exited.then(() => settleGroup(pid));

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
