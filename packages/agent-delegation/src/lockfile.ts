// per-repo git 写互斥锁（docs/WORKSPACE-ROOT-INJECTION.md 并发预算）：hub 多 worker
// 同仓形态下进程内 gitChain 互斥蒸发——git 写操作（worktree add/remove、branch -D、
// sweep）持 per-repo lockdir 跨进程互斥。锁目录 = <worktreeParent>/repo-<hash>.lock/
// （repo 外同级，与 worktree 同区）；内容文件 = 持锁 pid；持锁进程死亡后 stale 可抢。

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** pid 存活探测（process.kill 0 信号——对非子进程同样有效）。ESRCH=死（唯一死信号）；
 *  EPERM=进程在但属他用户（多用户共享机）——视为活（误判死会双临界区；误判活只损吞吐） */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

/** 创建窗口上限：mkdir 成功到 pid 文件落盘之间，等锁方按「被持」等待；超过该窗
 *  仍无 pid 文件 = 创建者 crash 在窗口内（永远写不出 pid）——判 stale 可抢。
 *  正常路径窗口 <10ms，30s 上限有充分余量。 */
const CREATING_WINDOW_MS = 30_000;

/** 锁持有者判定：pid 文件内容为活 pid 才算被持。pid 文件缺失 = 创建中窗口
 *  （mkdir 成功到 writeFile 完成之间）——视为被创建者持有，等锁方不得判 stale
 *  抢占（否则等锁方删创建者的锁目录，双持锁）；超窗仍缺 = 创建者已死。 */
async function lockHolder(lockDir: string, opts: { readonly creatingCountsAsHeld: boolean }): Promise<number | undefined> {
  const raw = await readFile(join(lockDir, "pid"), "utf8").catch(() => undefined);
  if (raw === undefined) {
    if (!opts.creatingCountsAsHeld) return undefined;
    const info = await stat(lockDir).catch(() => undefined);
    if (info === undefined) return undefined; // 锁目录已消失——重试 mkdir 即可
    return Date.now() - info.mtimeMs < CREATING_WINDOW_MS ? Number.NaN : undefined; // NaN=活锁占位
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(pid) && pid > 0 && pidAlive(pid) ? pid : undefined;
}

export interface RepoLock {
  readonly release: () => Promise<void>;
}

/** 等锁上限：到顶降级直跑临界区（无锁现状不劣化——挂死比无锁更糟，A 路 #6）。
 *  正常临界区为秒级 git 调用，60s 覆盖 pid 复用检测窗与慢仓 */
const LOCK_WAIT_MS = 60_000;
const RETRY_MS = 25;

/** 降级出口（N5）：互斥失效（超时/环境性错误）时上报——运维面可见，缺省静默 */
export type LockDegraded = (reason: string) => void;

/** 持锁执行（自旋等锁 + 临界区 + 必释放）。mkdir 原子性 = 唯一创建者即持锁者；
 *  stale（持锁进程死亡）抢占经 rm 重建。误抢最坏效果 = 与他进程 git 写并行，
 *  等同无锁现状，不劣化（降级经 onDegraded 可观测）。 */
export async function withRepoLock<T>(lockDir: string, critical: () => Promise<T>, onDegraded?: LockDegraded): Promise<T> {
  const degraded = (reason: string): void => onDegraded?.(`agents: repo lock degraded (${reason}): ${lockDir}`);
  const runUnlocked = (reason: string): Promise<T> => {
    degraded(reason);
    return critical();
  };
  // 父目录不存在时 mkdir(recursive:false) 恒 ENOENT（与被持互不可分）——先建父
  const parentReady = await mkdir(dirname(lockDir), { recursive: true }).then(
    () => true,
    () => false,
  ); // 父不可建（只读挂载/权限）→ 无锁可用：直接执行临界区（等同无锁现状，不劣化）
  if (!parentReady) return runUnlocked("parent dir unwritable");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockDir, { recursive: false }); // EEXIST 即被持/残留
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "EEXIST") {
        // 非竞争性失败（权限/只读等环境性错误）——自旋无出路，降级直跑（不劣化于无锁）
        return runUnlocked(`mkdir ${String(code)}`);
      }
      // pid 文件缺失 = 创建者仍在写（本进程同 tick 并发 or 极短窗口）——不能判 stale
      const holder = await lockHolder(lockDir, { creatingCountsAsHeld: true });
      if (holder !== undefined) {
        if (Date.now() > deadline) return runUnlocked("wait timeout"); // 超时降级（pid 复用等永久持锁形态——不挂死）
        await new Promise((resolve) => {
          setTimeout(resolve, RETRY_MS);
        });
        continue;
      }
      // pid 是死进程（crash 残留）——stale 抢占：删旧锁目录重建
      await rm(lockDir, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    try {
      await writeFile(join(lockDir, "pid"), String(process.pid));
    } catch {
      await rm(lockDir, { recursive: true, force: true }).catch(() => {});
      return runUnlocked("pid file unwritable"); // 持续写不可（目录只读等）——自旋无出路，降级直跑
    }
    try {
      return await critical();
    } finally {
      // 只在自己仍持有时删（pid 文件内容 = 本 pid）；否则留给持锁者
      const current = await readFile(join(lockDir, "pid"), "utf8").catch(() => undefined);
      if (current?.trim() === String(process.pid)) await rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** 锁目录路径（repoTop → 确定性路径；worktreeParent 目录下） */
export function repoLockPath(worktreeParentDir: string, repoTop: string): string {
  let hash = 0;
  for (const ch of repoTop) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return join(worktreeParentDir, `repo-${(hash >>> 0).toString(16)}.lock`);
}
