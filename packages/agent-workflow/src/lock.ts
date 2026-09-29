import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOCK_NAME = "lock";

export interface RunLock {
  readonly release: () => Promise<void>;
}

export type AcquireOutcome =
  | { readonly kind: "acquired"; readonly lock: RunLock }
  | { readonly kind: "busy" };

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

export async function acquireRunLock(dir: string): Promise<AcquireOutcome> {
  const lockPath = join(dir, LOCK_NAME);
  const content = `${process.pid}\n`;
  try {
    await writeFile(lockPath, content, { flag: "wx" });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
    await claimStaleLock(dir, lockPath);
    try {
      await writeFile(lockPath, content, { flag: "wx" });
    } catch (rebuild) {
      if (!isErrno(rebuild, "EEXIST") && !isErrno(rebuild, "ENOENT")) throw rebuild;
      return { kind: "busy" };
    }
  }
  return { kind: "acquired", lock: { release: () => unlink(lockPath).then(() => {}, () => {}) } };
}

async function claimStaleLock(dir: string, lockPath: string): Promise<void> {
  const holder = await readHolder(lockPath);
  if (holder !== undefined && pidAlive(holder)) return;
  const claimed = join(dir, `lock.claim-${String(process.pid)}`);
  try {
    await rename(lockPath, claimed);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    return;
  }
  await unlink(claimed).then(() => {}, () => {});
}
