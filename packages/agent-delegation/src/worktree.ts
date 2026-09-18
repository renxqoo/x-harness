// worktree 隔离（docs/AGENT-DELEGATION.md §8）：路径在 repo 外同级（避开 .git 受保护区
// 与主仓工作树污染）；git 调用经互斥队列串行（并发 spawn 不依赖 git 内部锁）；清理评估
// （status --porcelain 空 → worktree remove + branch -D；非空保留）；启动期对账清扫
// （父进程崩溃泄漏兜底）。

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** git 全局串行队列：worktree add/branch -D 并发行为未验证——spawn 侧消除竞态（方案 §8.1） */
let gitChain: Promise<unknown> = Promise.resolve();

function git(args: readonly string[], opts: { readonly cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  const run = gitChain.then(() => exec("git", args, { cwd: opts.cwd }));
  gitChain = run.catch(() => {});
  return run;
}

export interface WorktreePlan {
  readonly path: string;
  readonly branch: string;
  readonly repoTop: string;
}

export type WorktreeOutcome = { readonly ok: true; readonly plan: WorktreePlan } | { readonly ok: false; readonly reason: string };

/** worktree 父目录（repo 外同级） */
export function worktreeParent(repoTop: string): string {
  return join(dirname(repoTop), ".x-harness-worktrees");
}

async function repoTopOf(): Promise<{ ok: true; top: string } | { ok: false; reason: string }> {
  try {
    const out = await git(["rev-parse", "--show-toplevel"]);
    return { ok: true, top: out.stdout.trim() };
  } catch (error) {
    return { ok: false, reason: `not-a-git-repo (${errorText(error)})` };
  }
}

export async function createWorktree(agentId: string): Promise<WorktreeOutcome> {
  const top = await repoTopOf();
  if (!top.ok) return top;
  const branch = `x-harness/${agentId}`;
  const path = join(worktreeParent(top.top), `${basename(top.top)}-${agentId}`);
  try {
    await git(["worktree", "add", "-b", branch, path, "HEAD"], { cwd: top.top });
  } catch (error) {
    await git(["branch", "-D", branch], { cwd: top.top }).catch(() => {}); // 半建兜底
    return { ok: false, reason: `git worktree add failed (${errorText(error)})` };
  }
  return { ok: true, plan: { path, branch, repoTop: top.top } };
}

export interface CleanupResult {
  readonly removed: boolean;
  /** kept 时的路径（有改动保留） */
  readonly path?: string;
}

/** 清理评估：无改动 → remove + 分支删除；有改动 → 保留（改动不丢） */
export async function evaluateCleanup(plan: { readonly path: string; readonly branch: string }): Promise<CleanupResult> {
  if (!existsSync(plan.path)) return { removed: true }; // 已被清/已被 prune
  let status: string;
  try {
    status = (await git(["-C", plan.path, "status", "--porcelain"])).stdout;
  } catch {
    return { removed: false, path: plan.path }; // status 不可判 → 保守保留
  }
  if (status.trim() !== "") return { removed: false, path: plan.path };
  await git(["worktree", "remove", "--force", plan.path]).catch(() => {});
  await git(["branch", "-D", plan.branch]).catch(() => {});
  return { removed: !existsSync(plan.path) };
}

/** 启动期对账清扫：无 live 行对应的 worktree 目录（崩溃泄漏）——无改动清、有改动保留。
 *  新鲜度门槛（FRESH_MS）：目录 mtime 晚于该窗的不清——同仓他进程/本进程刚建的在用
 *  工作树防误删（审查 A-P1-2/B-P2-6；崩溃泄漏必然超过该窗，兜底语义不变）。 */
const FRESH_MS = 3_600_000;

export async function sweepWorktrees(livePaths: readonly string[], now: () => number = Date.now): Promise<readonly string[]> {
  const top = await repoTopOf();
  if (!top.ok) return [];
  const parent = worktreeParent(top.top);
  let entries: readonly string[];
  try {
    entries = await readdir(parent);
  } catch {
    return []; // 无 worktree 父目录
  }
  const kept: string[] = [];
  for (const entry of entries) {
    const path = join(parent, entry);
    if (livePaths.includes(path)) continue;
    const info = await stat(path).catch(() => undefined);
    if (info !== undefined && now() - info.mtimeMs < FRESH_MS) continue; // 新鲜树不清
    // 分支复原：<repo>-agent-<8hex> → agent-<8hex>（split("-").pop() 丢 agent- 前缀——审查 B-P1-4）
    const agentId = entry.slice(entry.indexOf("agent-"));
    if (agentId === "") continue;
    const result = await evaluateCleanup({ path, branch: `x-harness/${agentId}` });
    if (!result.removed) kept.push(path);
  }
  return kept;
}

function errorText(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : String(error);
}
