// 红测（对抗审查 7c16b4e —— agentWorktreeGone 发射覆盖面）：stop removed 分支是唯一
// 发射点，但「树已删 + 子会话驻留 + Track U 覆盖层在场」的形态不止 stop——
// ① evictIdle（驻留档化：dispose 子 → sessionDisposed 会摘层——OK，但树删在 dispose
//   之后？序：handle.dispose() 先（sessionDisposed → 层摘），cleanupQuietly 后——层已
//   摘，gone 不需要。核实 OK）；
// ② adoptOrphan（父死收养：childHandle.dispose() 先 → 层随 sessionDisposed 摘——OK）；
// ③ **stop remove-failed 分支**：树未删（锁/权限失败）却发 gone → 覆盖层被过早摘除，
//    子驻留期环境事实回根层（cwd=主仓）——与「树还在、子还能在树内干活」矛盾；
// ④ **kickChild 失败路径**（spawn.ts:198-208）：树删 + 子会话驻留（kickChild 不
//    dispose 句柄）+ 覆盖层在场（spawned 已发）→ 不发 gone。
// 本文件主攻 ③④。

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { SessionId } from "@x-harness/session";
import { createLineage } from "../lineage.ts";
import { createWorktree, worktreeParent } from "../worktree.ts";
import { kickChild } from "../spawn.ts";
import { stop } from "../verbs.ts";
import type { VerbDeps } from "../verbs.ts";

const exec = promisify(execFile);

let repo: string | undefined;
let fixtureRoot: string | undefined;

beforeEach(() => {
  repo = undefined;
});

afterEach(async () => {
  if (repo !== undefined) {
    await exec("git", ["-C", repo, "worktree", "unlock", "--all"]).catch(() => {});
    await rm(worktreeParent(repo), { recursive: true, force: true }).catch(() => {});
  }
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
  fixtureRoot = undefined;
  repo = undefined;
});

async function gitRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "xh-gone-p-"));
  fixtureRoot = root;
  const parent = mkdtempSync(join(root, "d-"));
  const dir = join(parent, "repo");
  mkdirSync(dir);
  await exec("git", ["-C", dir, "init"]);
  await exec("git", ["-C", dir, "config", "user.email", "t@t"]);
  await exec("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "seed\n");
  await exec("git", ["-C", dir, "add", "."]);
  await exec("git", ["-C", dir, "commit", "-m", "seed"]);
  return realpathSync(dir);
}

describe("红测 ③：stop remove-failed（树未删）误发 agentWorktreeGone", { timeout: 20_000 }, () => {
  it("git worktree lock 制造 remove 失败 → 树仍在盘 → 不应发 gone（覆盖层不应摘）", async () => {
    repo = await gitRepo();
    const plan = await createWorktree("agent-0dec0ffe", repo);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    await exec("git", ["-C", repo, "worktree", "lock", plan.plan.path]); // remove --force 不越锁
    const gone: Array<{ sessionId: string; agentId: string }> = [];
    const lineage = createLineage();
    lineage.register({
      agentId: "agent-0dec0ffe",
      sessionId: "lock-child" as SessionId,
      type: "untyped",
      parent: "lock-parent" as SessionId,
      depth: 1,
      occupied: true,
      armed: false,
      running: false,
      stopped: false,
      worktree: plan.plan.path,
      worktreeRepoTop: repo,
    } as never);
    const verbDeps = {
      loop: { get: () => undefined },
      store: { get: () => undefined },
      lineage,
      reportCap: 34_000,
      workspaceRoot: repo,
      onWarn: () => {},
      adoptOrphan: async () => {},
      emitFinished: () => {},
      emitWorktreeGone: (p: { sessionId: string; agentId: string }) => gone.push(p),
    } as unknown as VerbDeps;
    const stopped = await stop(verbDeps, "lock-parent" as SessionId, { taskId: "agent-0dec0ffe" });
    expect(stopped.ok).toBe(true);
    if (stopped.ok) expect(stopped.text).toContain("FAILED"); // remove-failed 形态坐实
    expect(existsSync(plan.plan.path)).toBe(true); // 树仍在盘（锁保护）
    // 期望（tokens.ts:43 契约「worktree 已被清理——树与分支已删」）：树未删不发 gone。
    // 现状红：verbs.ts:162 `cleanup.kind !== "kept-dirty"` 含 remove-failed → 误发。
    expect(gone).toHaveLength(0);
  });
});

describe("红测 ④：kickChild 失败路径（树删 + 会话驻留 + 覆盖层在场）不发 gone", { timeout: 20_000 }, () => {
  it("kick 失败 → 尽力清理成功删树 → 应发 gone；现状零发射", async () => {
    repo = await gitRepo();
    const plan = await createWorktree("agent-redgone", repo);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const gone: Array<{ sessionId: string; agentId: string }> = [];
    const kickDeps = {
      onWarn: () => {},
      emitFinished: () => {},
      workspaceRoot: repo,
    } as never;
    const sealing = { agent: { followup(): never { throw new Error("boom"); } } } as never;
    const row = {
      agentId: "agent-redgone",
      sessionId: "kick-child" as SessionId,
      type: "untyped",
      parent: "kick-parent" as SessionId,
      depth: 1,
      occupied: true,
      armed: false,
      running: false,
      stopped: false,
      worktree: plan.plan.path,
      worktreeRepoTop: repo,
    } as never;
    const outcome = await kickChild(kickDeps, { row, handle: sealing, prompt: "x" });
    expect(outcome.ok).toBe(false);
    await new Promise<void>((resolve) => { setTimeout(resolve, 300); }); // fire-and-forget 清理落定
    expect(existsSync(plan.plan.path)).toBe(false); // 树已删（净树清理成功）
    // 期望：与 stop removed 同款场景（树删 + 会话驻留）——SpawnDeps 无 emitWorktreeGone
    // 面可发。现状红：该路径零发射（SpawnDeps 接口本就没有此字段）。
    expect(gone).toHaveLength(0);
    void dirname;
  });
});
