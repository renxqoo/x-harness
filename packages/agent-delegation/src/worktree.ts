// worktree 隔离（docs/AGENT-DELEGATION.md §8 + docs/WORKSPACE-ROOT-INJECTION.md）：
// 路径在 repo 外同级（避开 .git 受保护区与主仓工作树污染）；git 调用显式携带 cwd
// （探测锚 workspaceRoot——宿主注入；写操作锚 repoTop——spawn 时落账的持久化事实，
// 跨装配 resume/fork 换 cwd 不漂移）；进程内 gitChain 串行 + 跨进程 per-repo lockfile
// （hub 多 worker 同仓形态）；清理评估（status --porcelain 空 → worktree remove +
// branch -D；非空保留）；启动期对账清扫（父进程崩溃泄漏兜底）。

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { repoLockPath, withRepoLock } from "./lockfile.ts";

const exec = promisify(execFile);

/** git 全局串行队列（进程内；跨进程互斥归 per-repo lockfile——方案并发预算） */
let gitChain: Promise<unknown> = Promise.resolve();

export function git(args: readonly string[], opts: { readonly cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  const run = gitChain.then(() => exec("git", args, { cwd: opts.cwd }));
  gitChain = run.catch(() => {});
  return run;
}

export interface WorktreePlan {
  readonly path: string;
  readonly branch: string;
  readonly repoTop: string;
}

export type WorktreeOutcome = { ok: true; plan: WorktreePlan } | { ok: false; reason: string };

/** worktree 父目录（repo 外同级） */
export function worktreeParent(repoTop: string): string {
  return join(dirname(repoTop), ".x-harness-worktrees");
}

/** 物理归一（realpathOrSelf——缺省同 PathGate 构造口径）：词法比较前消 symlink
 *  （macOS /var vs /private/var——逻辑形 workspaceRoot 对物理形 repoTop 会被词法
 *  比较误判「非祖先」，合法子目录误拒 workspace-not-in-repo）。 */
function physical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p); // 不存在（将被 git 失败面处理）——词法形兜底
  }
}

/** repoTop 归属校验：仓顶须是 workspaceRoot 自身或其祖先（物理归一后比较——
 *  逻辑形/物理形 symlink 分叉不做归一会把合法工作区误拒）。rev-parse 命中的仓顶
 *  在工作区之外（GIT_DIR 注入等防御面）时拒绝——防隔离基座被静默替换。 */
function ownsWorkspace(repoTop: string, workspaceRoot: string): boolean {
  const rel = relative(physical(repoTop), physical(workspaceRoot));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function repoTopOf(workspaceRoot: string): Promise<{ ok: true; top: string } | { ok: false; reason: string }> {
  try {
    const out = await git(["rev-parse", "--show-toplevel"], { cwd: workspaceRoot });
    const top = out.stdout.trim();
    if (!ownsWorkspace(top, workspaceRoot)) {
      return { ok: false, reason: `workspace-not-in-repo (nearest repo top '${top}' is not an ancestor of workspace '${workspaceRoot}')` };
    }
    return { ok: true, top };
  } catch (error) {
    return { ok: false, reason: `not-a-git-repo (${errorText(error)})` };
  }
}

export async function createWorktree(agentId: string, workspaceRoot: string): Promise<WorktreeOutcome> {
  const top = await repoTopOf(workspaceRoot);
  if (!top.ok) return top;
  const branch = `x-harness/${agentId}`;
  const path = join(worktreeParent(top.top), `${basename(top.top)}-${agentId}`);
  try {
    await withRepoLock(repoLockPath(worktreeParent(top.top), top.top), () => git(["worktree", "add", "-b", branch, path, "HEAD"], { cwd: top.top }));
  } catch (error) {
    // 半建兜底（写操作持锁——A 路 #7：并发预算的 branch -D 持锁面不许裸奔）
    await withRepoLock(repoLockPath(worktreeParent(top.top), top.top), () => git(["branch", "-D", branch], { cwd: top.top })).catch(() => {});
    return { ok: false, reason: `git worktree add failed (${errorText(error)})` };
  }
  return { ok: true, plan: { path, branch, repoTop: top.top } };
}

export type CleanupResult =
  | { readonly kind: "removed" }
  | { readonly kind: "kept-dirty"; readonly path: string }
  | { readonly kind: "remove-failed"; readonly path: string; readonly detail: string };

/** 清理评估（docs/WORKSPACE-ROOT-INJECTION.md 锚定规则）：无改动 → remove + 分支删除；
 *  有改动 → 保留（改动不丢）；remove 失败 → remove-failed（onWarn 由调用方接）。
 *  git 写操作锚 plan.repoTop（持久化事实——跨装配 resume/fork 换 cwd 不漂移）+
 *  per-repo lockfile（跨进程写互斥；锁不可重入——sweep 持锁时走 cleanupHeld）。 */
export async function evaluateCleanup(plan: WorktreePlan): Promise<CleanupResult> {
  return withRepoLock(repoLockPath(worktreeParent(plan.repoTop), plan.repoTop), () => cleanupHeld(plan));
}

/** 清理本体（调用方已持 repo 锁——sweep 全程持锁时复用，免同锁重入死锁） */
async function cleanupHeld(plan: WorktreePlan): Promise<CleanupResult> {
  if (!existsSync(plan.path)) {
    // 目录已被外部删除（rm）：git 仍登记该 worktree（branch -D 报 used by worktree）——
    // 先 prune 再删分支——第三条泄漏路径
    const pruned = await git(["worktree", "prune"], { cwd: plan.repoTop })
      .then(() => git(["branch", "-D", plan.branch], { cwd: plan.repoTop }))
      .then(
        () => true,
        () => false,
      );
    return pruned ? { kind: "removed" } : { kind: "remove-failed", path: plan.path, detail: "branch -D failed after worktree dir vanished" };
  }
  let status: string;
  try {
    status = (await git(["-C", plan.path, "status", "--porcelain"])).stdout;
  } catch {
    return { kind: "kept-dirty", path: plan.path }; // status 不可判 → 保守保留
  }
  if (status.trim() !== "") return { kind: "kept-dirty", path: plan.path };
  const removed = await (async () => {
    await git(["worktree", "remove", "--force", plan.path], { cwd: plan.repoTop });
    await git(["branch", "-D", plan.branch], { cwd: plan.repoTop });
    return !existsSync(plan.path);
  })().then(
    (ok: boolean) => ok,
    (error: unknown) => ({ failed: errorText(error) }) as const,
  );
  if (typeof removed !== "boolean") return { kind: "remove-failed", path: plan.path, detail: removed.failed };
  return removed ? { kind: "removed" } : { kind: "remove-failed", path: plan.path, detail: "worktree remove reported success but dir remains" };
}

/** 启动期对账清扫：无 live 行对应的 worktree 目录（崩溃泄漏）——无改动清、有改动保留。
 *  误删防线三层（方案并发预算）：livePaths（本进程活行）+ per-repo lockfile（跨进程写
 *  互斥）+ FRESH_MS 新鲜度窗。残余风险（他进程活树超窗无 mtime 更新）落档 §13。 */
const FRESH_MS = 3_600_000;

/** sweep 残留项（带形态——kept-dirty 与 remove-failed 分开报，不谎报 has changes） */
export interface SweepKept {
  readonly path: string;
  readonly kind: "kept-dirty" | "remove-failed";
}

/** 进程级活树登记簿（A 路 #5）：livePaths 若只取本插件实例的 lineage，apply 时刻恒空
 *  （行只在装配后由 spawn/revive 注册）——同进程 resume/fork 重装配的新实例会误扫旧
 *  实例的活树。登记簿跨实例共享：spawn/revive 建树登记，清理/拆卸摘除。 */
const liveTrees = new Set<string>();

export function registerLiveTree(path: string): void {
  liveTrees.add(path);
}

export function unregisterLiveTree(path: string): void {
  liveTrees.delete(path);
}

/** 当前活树快照（sweep livePaths 供给——含本进程全部装配实例） */
export function liveTreePaths(): readonly string[] {
  return [...liveTrees];
}

export async function sweepWorktrees(livePaths: readonly string[], workspaceRoot: string, now: () => number = Date.now): Promise<readonly SweepKept[]> {
  const top = await repoTopOf(workspaceRoot);
  if (!top.ok) return [];
  const parent = worktreeParent(top.top);
  // sweep 持锁全程（枚举+逐树评估+删除一个临界区——他进程 spawn/add 期间 sweep 不入）
  return withRepoLock(repoLockPath(parent, top.top), async () => {
    let entries: readonly string[];
    try {
      entries = await readdir(parent);
    } catch {
      return []; // 无 worktree 父目录
    }
    const kept: SweepKept[] = [];
    const ownPrefix = `${basename(top.top)}-agent-`; // 本仓条目前缀（共享父目录里兄弟仓共存——A 路 #3）
    for (const entry of entries) {
      if (entry.startsWith("repo-") && entry.endsWith(".lock")) continue; // lockfile 非工作树
      if (!entry.startsWith(ownPrefix)) continue; // 他仓的树不评估（跨仓 remove 必 128 → 永久假告警）
      const path = join(parent, entry);
      if (livePaths.includes(path)) continue;
      const info = await stat(path).catch(() => undefined);
      if (info !== undefined && now() - info.mtimeMs < FRESH_MS) continue; // 新鲜树不清
      // 分支复原：<repo>-agent-<8hex> → agent-<8hex>（取末段 "-agent-"——仓名含 "agent-"
      // 时 indexOf 会错位命中仓名内首段；agentId 恒为 8hex 后缀，lastIndexOf 才是分隔处）
      const at = entry.lastIndexOf("-agent-");
      if (at === -1) continue;
      const agentId = entry.slice(at + 1);
      if (agentId === "") continue;
      const result = await cleanupHeld({ path, branch: `x-harness/${agentId}`, repoTop: top.top });
      if (result.kind !== "removed") kept.push({ path, kind: result.kind });
    }
    return kept;
  });
}

function errorText(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : String(error);
}
