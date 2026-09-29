import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { repoLockPath, withRepoLock } from "./lockfile.ts";
import type { LockDegraded } from "./lockfile.ts";
import { branchOfHeadText, parseWorktreeGitdir, worktreeMainOfGitdir } from "./worktree-facts.ts";

const exec = promisify(execFile);

export type WorktreeFacts = import("./worktree-facts.ts").WorktreeFacts;

export async function worktreeFactsOf(path: string): Promise<WorktreeFacts | undefined> {
  if (path === "") return undefined;
  try {
    const raw = await readFile(join(path, ".git"), "utf8");
    const parsed = parseWorktreeGitdir(raw);
    if (parsed === undefined) return undefined;
    const head = await readFile(join(parsed.gitdir, "HEAD"), "utf8").catch(() => undefined);
    const branch = head !== undefined ? branchOfHeadText(head) : undefined;
    const main = worktreeMainOfGitdir(parsed.gitdir);
    if (branch === undefined && main === undefined) return undefined;
    return { ...(branch !== undefined ? { branch } : {}), ...(main !== undefined ? { worktreeMain: main } : {}) };
  } catch {
    return undefined;
  }
}

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
  readonly facts?: WorktreeFacts;
}

export type WorktreeOutcome = { ok: true; plan: WorktreePlan } | { ok: false; reason: string };

export function worktreeParent(repoTop: string): string {
  return join(dirname(repoTop), ".x-harness-worktrees");
}

function physical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

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

export async function createWorktree(agentId: string, workspaceRoot: string, onDegraded?: LockDegraded): Promise<WorktreeOutcome> {
  const top = await repoTopOf(workspaceRoot);
  if (!top.ok) return top;
  const branch = `x-harness/${agentId}`;
  const path = join(worktreeParent(top.top), `${basename(top.top)}-${agentId}`);
  try {
    await withRepoLock(repoLockPath(worktreeParent(top.top), top.top), () => git(["worktree", "add", "-b", branch, path, "HEAD"], { cwd: top.top }), onDegraded);
  } catch (error) {
    await withRepoLock(repoLockPath(worktreeParent(top.top), top.top), () => git(["branch", "-D", branch], { cwd: top.top }), onDegraded).catch(() => {});
    return { ok: false, reason: `git worktree add failed (${errorText(error)})` };
  }
  return { ok: true, plan: { path, branch, repoTop: top.top, facts: await worktreeFactsOf(path) } };
}

export type CleanupResult =
  | { readonly kind: "removed" }
  | { readonly kind: "kept-dirty"; readonly path: string }
  | { readonly kind: "remove-failed"; readonly path: string; readonly detail: string };

export async function evaluateCleanup(plan: WorktreePlan, onDegraded?: LockDegraded): Promise<CleanupResult> {
  return withRepoLock(repoLockPath(worktreeParent(plan.repoTop), plan.repoTop), () => cleanupHeld(plan), onDegraded);
}

async function branchGone(plan: WorktreePlan): Promise<boolean> {
  const out = await git(["branch", "--list", plan.branch], { cwd: plan.repoTop }).then(
    (r) => r.stdout,
    () => "",
  );
  return out.trim() === "";
}

async function cleanupHeld(plan: WorktreePlan): Promise<CleanupResult> {
  if (!existsSync(plan.path)) {
    const pruned = await git(["worktree", "prune"], { cwd: plan.repoTop })
      .then(() => git(["branch", "-D", plan.branch], { cwd: plan.repoTop }))
      .then(
        () => true,
        async (error: unknown) => {
          const text = (error as { stderr?: string }).stderr ?? "";
          return /error: branch '[^']+' not found/.test(text) || (await branchGone(plan));
        },
      );
    return pruned ? { kind: "removed" } : { kind: "remove-failed", path: plan.path, detail: "branch -D failed after worktree dir vanished" };
  }
  let status: string;
  try {
    status = (await git(["-C", plan.path, "status", "--porcelain"])).stdout;
  } catch {
    return { kind: "kept-dirty", path: plan.path };
  }
  if (status.trim() !== "") return { kind: "kept-dirty", path: plan.path };
  const others = await git(["branch", "--contains", plan.branch], { cwd: plan.repoTop }).then(
    (r) => r.stdout.split("\n").map((l) => l.replace(/^[*+] /, "").trim()).filter((n) => n !== "" && n !== plan.branch),
    () => null,
  );
  if (others === null ? !(await branchGone(plan)) : others.length === 0) {
    return { kind: "kept-dirty", path: plan.path };
  }
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

const FRESH_MS = 3_600_000;

export interface SweepKept {
  readonly path: string;
  readonly kind: "kept-dirty" | "remove-failed";
}

export async function mainRepoTopOf(worktree: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(worktree, ".git"), "utf8");
    const parsed = parseWorktreeGitdir(raw);
    return parsed === undefined ? undefined : worktreeMainOfGitdir(parsed.gitdir);
  } catch {
    return undefined;
  }
}

const liveTrees = new Set<string>();

export function registerLiveTree(path: string): void {
  liveTrees.add(path);
}

export function unregisterLiveTree(path: string): void {
  liveTrees.delete(path);
}

export function liveTreePaths(): readonly string[] {
  return [...liveTrees];
}

export async function sweepWorktrees(livePaths: readonly string[], workspaceRoot: string, tail: { readonly now?: () => number; readonly onDegraded?: LockDegraded } = {}): Promise<readonly SweepKept[]> {
  const top = await repoTopOf(workspaceRoot);
  if (!top.ok) return [];
  const parent = worktreeParent(top.top);
  return withRepoLock(repoLockPath(parent, top.top), async () => {
    let entries: readonly string[];
    try {
      entries = await readdir(parent);
    } catch {
      return [];
    }
    const kept: SweepKept[] = [];
    const ownPrefix = `${basename(top.top)}-agent-`;
    for (const entry of entries) {
      if (entry.startsWith("repo-") && entry.endsWith(".lock")) continue;
      if (!entry.startsWith(ownPrefix)) continue;
      const path = join(parent, entry);
      if (livePaths.includes(path)) continue;
      const info = await stat(path).catch(() => undefined);
      if (info !== undefined && (tail.now ?? Date.now)() - info.mtimeMs < FRESH_MS) continue;
      const at = entry.lastIndexOf("-agent-");
      if (at === -1) continue;
      const agentId = entry.slice(at + 1);
      if (agentId === "") continue;
      const result = await cleanupHeld({ path, branch: `x-harness/${agentId}`, repoTop: top.top });
      if (result.kind !== "removed") kept.push({ path, kind: result.kind });
    }
    return kept;
  }, tail.onDegraded);
}

function errorText(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : String(error);
}
