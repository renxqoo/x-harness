import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOCK_NAME = "lock";

export interface SessionLock {
  readonly release: () => Promise<void>;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function parsePid(text: string): number | undefined {
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

async function readHolder(lockPath: string): Promise<number | undefined> {
  try {
    return parsePid(await readFile(lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

export async function acquireSessionLock(dir: string, sessionLabel: string): Promise<SessionLock> {
  const lockPath = join(dir, LOCK_NAME);
  const content = `${process.pid}\n`;
  try {
    await writeFile(lockPath, content, { flag: "wx" });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
    await claimStaleLock({ dir, lockPath, sessionLabel });
    try {
      await writeFile(lockPath, content, { flag: "wx" });
    } catch (rebuild) {
      if (!isErrno(rebuild, "EEXIST")) throw rebuild;
      const holder = await readHolder(lockPath);
      const detail = holder !== undefined && pidAlive(holder) ? `pid-${holder}` : "takeover-race";
      throw Object.assign(new Error(`session-locked:${sessionLabel}:${detail}`), { permanent: true });
    }
  }
  return {
    release: () => unlink(lockPath).then(
      () => {},
      () => {},
    ),
  };
}

async function claimStaleLock(input: { readonly dir: string; readonly lockPath: string; readonly sessionLabel: string }): Promise<void> {
  const holder = await readHolder(input.lockPath);
  if (holder !== undefined && pidAlive(holder)) {
    throw Object.assign(new Error(`session-locked:${input.sessionLabel}:pid-${holder}`), { permanent: true });
  }
  const claimed = join(input.dir, `lock.claim-${String(process.pid)}`);
  try {
    await rename(input.lockPath, claimed);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    return;
  }
  await unlink(claimed).then(
    () => {},
    () => {},
  );
}
