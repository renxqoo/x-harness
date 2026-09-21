// 会话删除（BATCH2-DESIGN §4）：围栏（词法 + realpath）→ 活族先拒（占用表纯读——
// live worker 持活锁，词表正确串 already open 先于 lock 探活）→ 目录缺席幂等（活族
// 不因缺席放行）→ lock 探活（跨 host 防线，兼覆盖「创建中 header 未落」窗口）→
// 子代理拒删 → 血缘级联集 + trash 预建 → **状态变更段（同步表操作与 rename 发起之间
// 零 await）**：撤表 → 原子 rename-to-trash（sessionsRoot 即刻消失）→ 异步 rm（trash
// 残迹 tmp-sweep 兜底）。幂等：目标不在 = success。
import { mkdir, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createArchiveReader } from "@x-harness/session-persistence-jsonl";
import type { ThreadTable } from "./thread-table.ts";
import { fenceSessionPath } from "./read-history.ts";

export interface DeleteDeps {
  readonly table: ThreadTable;
  readonly sessionsRoot: string;
  readonly agentDir: string;
}

export type DeleteResult = { ok: true; removed: string[] } | { ok: false; reason: string };

/** 活族判定（live/spawning/retiring——含表项缺席的防御形态）：删除面唯二拒绝态之一 */
function isLiveFamily(state: string | undefined): boolean {
  return state === undefined || state === "live" || state === "spawning" || state === "retiring";
}

/** lock 探活：内容 = 纯 pid（O_EXCL 创建者写入）；活进程 → 拒（check-then-act 窗口
 *  由 rename 原子性收窄到瞬时——跨 host 并发删除同一会话不在支持矩阵，DESIGN §3.10） */
async function lockHeldByLiveProcess(dir: string): Promise<boolean> {
  const raw = await readFile(join(dir, "lock"), "utf8").catch(() => undefined);
  if (raw === undefined) return false;
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false; // 垃圾内容视同无锁（可删——rm 连锁清）
  try {
    process.kill(pid, 0);
    return true; // EPERM（存在但无权限）与成功同义：活
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 子代理会话判据：header.json 带 agentId（归 delegation 生命周期管理——task_output/
 *  惰性复活依赖档案）；header 缺失/损坏 = 孤儿目录，仍可删 */
async function isSubagentSession(dir: string): Promise<boolean> {
  const raw = await readFile(join(dir, "header.json"), "utf8").catch(() => undefined);
  if (raw === undefined) return false;
  try {
    const header = JSON.parse(raw) as { agentId?: unknown };
    return typeof header.agentId === "string" && header.agentId !== "";
  } catch {
    return false;
  }
}

/** 级联收集：header.parentSession 血缘 BFS（全子孙——子代理会话在 list_saved 不可见，
 *  不级联即永不可清的隐形垃圾） */
async function descendantIds(sessionsRoot: string, rootId: string): Promise<string[]> {
  const headers = await createArchiveReader(sessionsRoot).listHeaders().catch(() => undefined);
  if (headers === undefined) return [];
  const byParent = new Map<string, string[]>();
  for (const header of headers) {
    if (header.parentSession === undefined) continue;
    const siblings = byParent.get(String(header.parentSession)) ?? [];
    siblings.push(String(header.id));
    byParent.set(String(header.parentSession), siblings);
  }
  const seen = new Set<string>([rootId]);
  const out: string[] = [];
  let frontier = byParent.get(rootId) ?? [];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue; // 环防御
      seen.add(id);
      out.push(id);
      next.push(...(byParent.get(id) ?? []));
    }
    frontier = next;
  }
  return out;
}

type VanishOutcome = "renamed" | "absent" | "failed";

/** 原子消失单目录：rename → `<agentDir>/trash/<id>.<pid>.<rand>`（名字碰撞换随机重试）。
 *  rename 保留原 mtime——touch 至当下使 trash 的 1h 回收窗真实（否则旧 mtime 恒过线，
 *  启动清扫会与在途 rm 竞争） */
async function vanishToTrash(dir: string, agentDir: string, id: string): Promise<VanishOutcome> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const trash = join(agentDir, "trash", `${id}.${process.pid}.${randomBytes(6).toString("hex")}`);
    try {
      await rename(dir, trash);
      const now = new Date();
      await utimes(trash, now, now).catch(() => {});
      void rm(trash, { recursive: true, force: true }).catch(() => {}); // 异步尾；残迹 tmp-sweep 回收
      return "renamed";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "absent"; // 已删/从未存在（幂等）
      if (code !== "EEXIST" && code !== "ENOTEMPTY") return "failed"; // 随机名碰撞外的失败如实上报
    }
  }
  return "failed";
}

/** 撤除指向 path 的表项（幂等删除路径的表卫生） */
function withdrawTableEntry(table: ThreadTable, sessionPath: string): void {
  const holder = table.holderOf(sessionPath);
  if (holder !== undefined) table.remove(holder);
}

export async function deleteSession(deps: DeleteDeps, sessionPath: string): Promise<DeleteResult> {
  const fence = await fenceSessionPath(sessionPath, deps.sessionsRoot);
  if (!fence.ok) return { ok: false, reason: fence.reason };
  const dir = join(deps.sessionsRoot, fence.threadId);
  const canonicalPath = join(deps.sessionsRoot, fence.threadId, "events.jsonl");
  /** 占用态读回："none" = 无持有者（可删）；undefined = 持有者存在但表项缺（防御形态
   *  ——按活族拒）；其余 = 表项状态 */
  const holderState = (): "none" | string | undefined => {
    const holder = deps.table.holderOf(canonicalPath);
    if (holder === undefined) return "none";
    return deps.table.get(holder)?.state;
  };

  // —— 只读检查段（await 允许——此段不改状态）——
  const dirStat = await stat(dir).catch((error: unknown) => error as NodeJS.ErrnoException);
  if (dirStat instanceof Error && dirStat.code !== "ENOENT") {
    return { ok: false, reason: `delete failed: ${dirStat.code ?? "stat"}` }; // EACCES 等不伪装缺席
  }
  if (dirStat instanceof Error) {
    // 目录缺席（幂等路径）：活族不因缺席放行（外部 rm 后 worker 仍活——先 stop）
    if (isLiveFamily(holderState())) return { ok: false, reason: "already open" };
    withdrawTableEntry(deps.table, canonicalPath); // 表残留一并撤
    return { ok: true, removed: [] };
  }
  // 活族先拒（纯读）：live worker 持活锁——先于 lock 探活给词表正确串
  if (isLiveFamily(holderState())) return { ok: false, reason: "already open" };
  if (await lockHeldByLiveProcess(dir)) {
    return { ok: false, reason: "session is locked by another process" };
  }
  if (await isSubagentSession(dir)) {
    return { ok: false, reason: "cannot delete subagent session" };
  }
  const children = await descendantIds(deps.sessionsRoot, fence.threadId);
  await mkdir(join(deps.agentDir, "trash"), { recursive: true }).catch(() => {}); // 预建——状态变更段零 await

  // —— 状态变更段：同步表操作与 rename 发起之间零 await（穿窗收敛分析 DESIGN §4.2）——
  withdrawTableEntry(deps.table, canonicalPath); // 活族已拒——此处只剩 parked/dead/无表项

  const removed: string[] = [];
  const vanished = await vanishToTrash(dir, deps.agentDir, fence.threadId);
  if (vanished === "failed") return { ok: false, reason: "delete failed: rename" };
  if (vanished === "renamed") removed.push(fence.threadId);
  for (const child of children) {
    const outcome = await vanishToTrash(join(deps.sessionsRoot, child), deps.agentDir, child);
    if (outcome === "renamed") {
      removed.push(child);
      withdrawTableEntry(deps.table, join(deps.sessionsRoot, child, "events.jsonl")); // 子表卫生
    } else if (outcome === "failed") {
      process.stderr.write(`hub: session-delete cascade skipped ${child}\n`); // 不静默
    }
  }
  return { ok: true, removed };
}
