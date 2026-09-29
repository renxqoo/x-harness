import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

const CREATING_WINDOW_MS = 30_000;

async function lockHolder(lockDir: string, opts: { readonly creatingCountsAsHeld: boolean }): Promise<number | undefined> {
  const raw = await readFile(join(lockDir, "pid"), "utf8").catch(() => undefined);
  if (raw === undefined) {
    if (!opts.creatingCountsAsHeld) return undefined;
    const info = await stat(lockDir).catch(() => undefined);
    if (info === undefined) return undefined;
    return Date.now() - info.mtimeMs < CREATING_WINDOW_MS ? Number.NaN : undefined;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(pid) && pid > 0 && pidAlive(pid) ? pid : undefined;
}

const LOCK_WAIT_MS = 60_000;
const RETRY_MS = 25;

export type LockDegraded = (reason: string) => void;

export async function withRepoLock<T>(lockDir: string, critical: () => Promise<T>, onDegraded?: LockDegraded): Promise<T> {
  const degraded = (reason: string): void => onDegraded?.(`agents: repo lock degraded (${reason}): ${lockDir}`);
  const runUnlocked = (reason: string): Promise<T> => {
    degraded(reason);
    return critical();
  };
  const parentReady = await mkdir(dirname(lockDir), { recursive: true }).then(
    () => true,
    () => false,
  );
  if (!parentReady) return runUnlocked("parent dir unwritable");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockDir, { recursive: false });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT" && Date.now() <= deadline) {
        await mkdir(dirname(lockDir), { recursive: true }).catch(() => {});
        continue;
      }
      if (code !== "EEXIST") {
        return runUnlocked(`mkdir ${String(code ?? "unknown error")}`);
      }
      const holder = await lockHolder(lockDir, { creatingCountsAsHeld: true });
      if (holder !== undefined) {
        if (Date.now() > deadline) return runUnlocked("wait timeout");
        await new Promise((resolve) => {
          setTimeout(resolve, RETRY_MS);
        });
        continue;
      }
      await rm(lockDir, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    try {
      await writeFile(join(lockDir, "pid"), String(process.pid));
    } catch {
      await rm(lockDir, { recursive: true, force: true }).catch(() => {});
      return runUnlocked("pid file unwritable");
    }
    try {
      return await critical();
    } finally {
      const current = await readFile(join(lockDir, "pid"), "utf8").catch(() => undefined);
      if (current?.trim() === String(process.pid)) await rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export function repoLockPath(worktreeParentDir: string, repoTop: string): string {
  let hash = 0;
  for (const ch of repoTop) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return join(worktreeParentDir, `repo-${(hash >>> 0).toString(16)}.lock`);
}
