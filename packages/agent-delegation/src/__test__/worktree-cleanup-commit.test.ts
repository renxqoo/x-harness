// 清理判据「无改动」的提交面（docs/AGENT-DELEGATION.md §8.3）：净树 ≠ 无改动——
// 子代理 commit 后工作区干净，但分支上的未合并提交是仅存副本，branch -D 即孤儿化。
// 判据 = 分支头被其他本地分支包含（头被包含 ⟺ 全部祖先被包含；基线不假设 main）。

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { Plugin } from "@x-harness/core";
import { GrantsRegistry, permissionGrants } from "@x-harness/permission";
import type { SessionId } from "@x-harness/session";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, makeOptions, resetWorlds, agentIdOf } from "./world.ts";
import { worktreeParent } from "../worktree.ts";

const exec = promisify(execFile);

let repo: string | undefined;
let scratch: string[] = [];

beforeEach(() => {
  resetWorlds();
});

afterEach(async () => {
  if (repo !== undefined) await rm(worktreeParent(repo), { recursive: true, force: true }).catch(() => {});
  for (const dir of scratch) await rm(dir, { recursive: true, force: true }).catch(() => {});
  scratch = [];
  repo = undefined;
});

/** 夹具父目录独占（跨用例互删防线，同 worktree.test.ts 口径） */
function fixtureDir(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `xh-wtc-${tag}-p-`));
  return mkdtempSync(join(root, "d-"));
}

/** 真仓夹具：git -C 显式（无 ambient cwd 依赖）；返回物理路径 */
async function gitRepo(): Promise<string> {
  const parent = fixtureDir("repo");
  scratch = [...scratch, dirname(parent)];
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

const grantsStub = (): Plugin => ({
  name: "grants-stub",
  apply: (ctx) => ctx.provide(permissionGrants, new GrantsRegistry()),
});

/** worktree 世界：workspaceRoot 显式指仓（hub 形态） */
async function worktreeWorld() {
  const options = await makeOptions({}, { workspaceRoot: repo as string, worktreeSweep: false });
  const world = await makeWorld(options, undefined, [grantsStub()]);
  const parent = await spawnParent(world, PARENT_MODEL, "wt-clean" as SessionId);
  world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
  return { world, parent };
}

const spawnWorktree = (world: Awaited<ReturnType<typeof worktreeWorld>>) =>
  callTool({ world: world.world, name: "agent_spawn", args: { description: "isolated work", prompt: "x", isolation: "worktree" }, session: world.parent.agent.session.id });

/** spawn 后定位 worktree 路径（父目录里含 agentId 的条目） */
async function wtPathOf(agentId: string): Promise<string> {
  const entry = (await readdir(worktreeParent(repo as string))).find((f) => f.includes(agentId)) ?? "";
  return join(worktreeParent(repo as string), entry);
}

describe("清理判据提交面（§8.3 净树 ≠ 无改动）", { timeout: 20_000 }, () => {
  // 数据丢失级回归锚：旧实现只看 status --porcelain（净树即删）。
  // 症状：净树 + 分支领先 → 被判「无改动」删分支，未合并提交永久丢失
  it("净树但分支有未合并提交 → 保留（commit 后 status 干净，branch -D 会孤儿化提交）", async () => {
    repo = await gitRepo();
    const twins = await worktreeWorld();
    const spawned = await spawnWorktree(twins);
    const agentId = agentIdOf(spawned.content);
    const wtPath = await wtPathOf(agentId);
    await exec("git", ["-C", wtPath, "commit", "--allow-empty", "-m", "agent work committed"]);
    const status = await exec("git", ["-C", wtPath, "status", "--porcelain"]);
    expect(status.stdout.trim()).toBe(""); // 前置坐实：工作树确实干净（旧实现盲区形态）
    const stopped = await callTool({ world: twins.world, name: "task_stop", args: { task_id: agentId }, session: twins.parent.agent.session.id });
    expect(stopped.content).toContain(`worktree kept (has changes): ${wtPath}`);
    expect(existsSync(wtPath)).toBe(true); // 分支保留——未合并提交不丢
    const branches = await exec("git", ["-C", repo, "branch", "--list", `x-harness/${agentId}`]);
    expect(branches.stdout.trim()).not.toBe(""); // 分支仍在
    await twins.parent.dispose();
    await rm(wtPath, { recursive: true, force: true }).catch(() => {});
  });

  // 对称面（泄漏防线）：分支头已被其他本地分支包含（用户已 merge/ff 收编）→ 无独有提交，
  // 正常清理。防止新判据把已收编的分支也永久保留
  it("净树且分支头已被其他分支包含（已收编）→ 照常清理（remove + branch -D）", async () => {
    repo = await gitRepo();
    const twins = await worktreeWorld();
    const spawned = await spawnWorktree(twins);
    const agentId = agentIdOf(spawned.content);
    const wtPath = await wtPathOf(agentId);
    await exec("git", ["-C", wtPath, "commit", "--allow-empty", "-m", "will be merged"]);
    await exec("git", ["-C", repo, "merge", "--ff-only", `x-harness/${agentId}`]); // 主仓收编
    const stopped = await callTool({ world: twins.world, name: "task_stop", args: { task_id: agentId }, session: twins.parent.agent.session.id });
    expect(stopped.content).not.toContain("worktree kept");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(existsSync(wtPath)).toBe(false);
    const branches = await exec("git", ["-C", repo, "branch", "--list", `x-harness/${agentId}`]);
    expect(branches.stdout.trim()).toBe(""); // 分支双清（提交已在主仓，删除不丢数据）
    await twins.parent.dispose();
  });

  // contains 不可判面：分支 ref 存在但指向坏对象（对象库损坏）→ branch --contains 失败、
  // --list 成功（走 refs 不碰对象库）→ 保守保留（不可判不等于无独有提交）
  it("分支 ref 指向坏对象（contains 失败但分支仍在）→ 保守保留", async () => {
    repo = await gitRepo();
    const twins = await worktreeWorld();
    const spawned = await spawnWorktree(twins);
    const agentId = agentIdOf(spawned.content);
    const wtPath = await wtPathOf(agentId);
    const gitDir = (await exec("git", ["-C", repo, "rev-parse", "--absolute-git-dir"])).stdout.trim();
    await rm(join(gitDir, "refs", "heads", "x-harness", `${agentId}`), { force: true }).catch(() => {});
    const { writeFileSync: writeRef } = await import("node:fs");
    writeRef(join(gitDir, "refs", "heads", "x-harness", agentId), "0000000000000000000000000000000000000000\n");
    const stopped = await callTool({ world: twins.world, name: "task_stop", args: { task_id: agentId }, session: twins.parent.agent.session.id });
    expect(stopped.content).toContain(`worktree kept (has changes): ${wtPath}`);
    expect(existsSync(wtPath)).toBe(true);
    await twins.parent.dispose();
    await rm(wtPath, { recursive: true, force: true }).catch(() => {});
  });
});
