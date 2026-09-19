// 会话目录单写者锁（docs/CLI.md §2.6）：跨进程双开同一会话会交织写坏日志（前缀校验只在
// 打开瞬间做，之后各持 append fd 自由追加 → archive-prefix-mismatch 会话报废）。
// 形态：`<会话目录>/lock` 文件 O_EXCL 创建 + 持有 pid；活进程在锁 → session-locked 永久拒绝
// （调用方 fail-fast）；持有方已死（ESRCH）或锁内容不可解析（崩溃半写）→ 接管重写。
// 属咨询锁的已知边界：pid 复用会误判存活（拒绝打开，安全侧失败）；释放是尽力而为
//（进程崩溃残留死锁，下次打开由 pid 活性检测接管）。

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOCK_NAME = "lock";

export interface SessionLock {
  readonly release: () => Promise<void>;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

/** pid 活性：signal 0 探测。EPERM 等 = 进程在但属主不同 → 保守视为存活 */
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

/** 打开即取锁：拒绝错误带 permanent 标记（与 writer 的永久拒绝同通道，plugin dead 闩接管）。
 *  接管（前主已死/垃圾锁）：先 rename(2) 原子摘除陈旧锁（并发接管恰一胜者，败者 ENOENT），
 *  再 O_EXCL 重建——重建权威在 wx：即便摘除与重建间有他方先建，wx EEXIST 后按新持有者
 *  活锁判定拒绝。unlink+重写方案有 check-then-act 竞态（败者 unlink 掉胜者的活锁），弃用 */
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

/** 摘除陈旧锁：活锁拒绝；死/垃圾锁 rename 原子摘除（败者 ENOENT 直接返回，重建阶段收敛） */
async function claimStaleLock(input: { readonly dir: string; readonly lockPath: string; readonly sessionLabel: string }): Promise<void> {
  const holder = await readHolder(input.lockPath);
  if (holder !== undefined && pidAlive(holder)) {
    throw Object.assign(new Error(`session-locked:${input.sessionLabel}:pid-${holder}`), { permanent: true });
  }
  const claimed = join(input.dir, `lock.claim-${String(process.pid)}`);
  try {
    await rename(input.lockPath, claimed);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error; // 已被他方摘除：无陈旧项可清，直接走重建
    return;
  }
  await unlink(claimed).then(
    () => {},
    () => {},
  );
}
