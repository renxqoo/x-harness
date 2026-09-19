// 会话目录单写者锁（docs/CLI.md §2.6）：跨进程双开同一会话会交织写坏日志（前缀校验只在
// 打开瞬间做，之后各持 append fd 自由追加 → archive-prefix-mismatch 会话报废）。
// 形态：`<会话目录>/lock` 文件 O_EXCL 创建 + 持有 pid；活进程在锁 → session-locked 永久拒绝
// （调用方 fail-fast）；持有方已死（ESRCH）或锁内容不可解析（崩溃半写）→ 接管重写。
// 属咨询锁的已知边界：pid 复用会误判存活（拒绝打开，安全侧失败）；释放是尽力而为
//（进程崩溃残留死锁，下次打开由 pid 活性检测接管）。

import { readFile, unlink, writeFile } from "node:fs/promises";
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

/** 打开即取锁：拒绝错误带 permanent 标记（与 writer 的永久拒绝同通道，plugin dead 闩接管） */
export async function acquireSessionLock(dir: string, sessionLabel: string): Promise<SessionLock> {
  const lockPath = join(dir, LOCK_NAME);
  const content = `${process.pid}\n`;
  try {
    await writeFile(lockPath, content, { flag: "wx" });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
    const holder = await readHolder(lockPath);
    if (holder !== undefined && pidAlive(holder)) {
      throw Object.assign(new Error(`session-locked:${sessionLabel}:pid-${holder}`), { permanent: true });
    }
    await writeFile(lockPath, content, { flag: "w" }); // 前主已死/锁内容不可解析 → 接管
  }
  return {
    release: () => unlink(lockPath).then(
      () => {},
      () => {},
    ),
  };
}
