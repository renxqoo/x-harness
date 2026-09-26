// run 锁（docs/AGENT-WORKFLOW.md §3.1——照 session-persistence-jsonl/src/lock.ts 全套）：
// pid-only、活锁拒绝、死锁 rename 原子接管（wx 重建权威）。run 场景差异：
// 拒绝映射为「跳过不报错」（§5.1 多进程共享 root 安全），由调用方决定语义。

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOCK_NAME = "lock";

export interface RunLock {
  readonly release: () => Promise<void>;
}

export type AcquireOutcome =
  | { readonly kind: "acquired"; readonly lock: RunLock }
  /** 活锁（他进程持有）或接管竞态败者——调用方跳过不报错（§5.1） */
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

/** 取 run 锁：全新/死锁接管 → acquired；活锁/竞态败 → busy（不 throw——run 驱动可放弃）。 */
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

/** 死锁摘除（活锁静默败——区别于 session 锁的 permanent 拒绝，run 场景跳过即语义） */
async function claimStaleLock(dir: string, lockPath: string): Promise<void> {
  const holder = await readHolder(lockPath);
  if (holder !== undefined && pidAlive(holder)) return; // 活锁 → 重建 wx EEXIST → busy
  const claimed = join(dir, `lock.claim-${String(process.pid)}`);
  try {
    await rename(lockPath, claimed);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    return;
  }
  await unlink(claimed).then(() => {}, () => {});
}
