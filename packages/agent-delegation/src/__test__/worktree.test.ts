import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { Plugin } from "@x-harness/core";
import { GrantsRegistry, permissionGrants } from "@x-harness/permission";
import type { SessionId } from "@x-harness/session";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, makeOptions, resetWorlds, agentIdOf } from "./world.ts";
import { createWorktree, evaluateCleanup, liveTreePaths, registerLiveTree, sweepWorktrees, unregisterLiveTree, worktreeParent } from "../worktree.ts";
import { withRepoLock, repoLockPath } from "../lockfile.ts";

const exec = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

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

function fixtureDir(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `xh-wt-${tag}-p-`));
  return mkdtempSync(join(root, "d-"));
}

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

async function worktreeWorld(overrides: { readonly onWarn?: (m: string) => void } = {}) {
  return worktreeWorldAt(repo as string, overrides);
}

async function worktreeWorldAt(root: string, overrides: { readonly onWarn?: (m: string) => void } = {}) {
  const options = await makeOptions({}, { workspaceRoot: root, worktreeSweep: false, ...(overrides.onWarn !== undefined ? { onWarn: overrides.onWarn } : {}) });
  const world = await makeWorld(options, undefined, [grantsStub()]);
  const parent = await spawnParent(world, PARENT_MODEL, "wt-main" as SessionId);
  world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
  return { world, parent };
}

const spawnWorktree = (world: Awaited<ReturnType<typeof worktreeWorld>>) =>
  callTool({ world: world.world, name: "agent_spawn", args: { description: "isolated work", prompt: "x", isolation: "worktree" }, session: world.parent.agent.session.id });

describe("worktree 隔离（§8）", { timeout: 20_000 }, () => {
  it("workspaceRoot 锚定（进程 cwd 非夹具仓）：repo 外路径建树 + 授权根落账（真隔离）；task_stop 无改动自动清理（树与分支消失）", async () => {
    repo = await gitRepo();
    const twins = await worktreeWorld();
    const spawned = await spawnWorktree(twins);
    expect(spawned.isError).toBeUndefined();
    const agentId = agentIdOf(spawned.content);
    const parentDir = worktreeParent(repo);
    const entry = (await readdir(parentDir)).find((f) => f.includes(agentId));
    expect(entry).toBeDefined();
    const wtPath = join(parentDir, entry ?? "");
    expect(existsSync(join(wtPath, "README.md"))).toBe(true);
    const grants = twins.world.ctx.tryUse(permissionGrants);
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [""])[1] as SessionId;
    expect(grants?.rootOverrideOf(childSession)).toEqual({ dir: wtPath, guard: repo });
    const stopped = await callTool({ world: twins.world, name: "task_stop", args: { task_id: agentId }, session: twins.parent.agent.session.id });
    expect(stopped.isError).toBeUndefined();
    expect(stopped.content).not.toContain("worktree kept");
    await sleep(50);
    expect(existsSync(wtPath)).toBe(false);
    const branches = await exec("git", ["-C", repo, "branch", "--list", `x-harness/${agentId}`]);
    expect(branches.stdout.trim()).toBe("");
    await twins.parent.dispose();
  });

  it("有改动 stop → worktree 保留且文案带路径（kept-dirty）", async () => {
    repo = await gitRepo();
    const twins = await worktreeWorld();
    const spawned = await spawnWorktree(twins);
    const agentId = agentIdOf(spawned.content);
    const wtEntry = (await readdir(worktreeParent(repo))).find((f) => f.includes(agentId)) ?? "";
    const wtPath = join(worktreeParent(repo), wtEntry);
    writeFileSync(join(wtPath, "NEW.md"), "changes\n");
    const stopped = await callTool({ world: twins.world, name: "task_stop", args: { task_id: agentId }, session: twins.parent.agent.session.id });
    expect(stopped.content).toContain(`worktree kept (has changes): ${wtPath}`);
    expect(existsSync(wtPath)).toBe(true);
    await twins.parent.dispose();
    await rm(wtPath, { recursive: true, force: true }).catch(() => {});
  });


  it("remove 失败可见：git worktree lock 制造 → stop 文案报 remove-failed（非 has changes）+ onWarn 告警", async () => {
    repo = await gitRepo();
    const warnings: string[] = [];
    const twins = await worktreeWorld({ onWarn: (m) => warnings.push(m) });
    const spawned = await spawnWorktree(twins);
    const agentId = agentIdOf(spawned.content);
    const wtEntry = (await readdir(worktreeParent(repo))).find((f) => f.includes(agentId)) ?? "";
    const wtPath = join(worktreeParent(repo), wtEntry);
    await exec("git", ["-C", repo, "worktree", "lock", wtPath]);
    const stopped = await callTool({ world: twins.world, name: "task_stop", args: { task_id: agentId }, session: twins.parent.agent.session.id });
    expect(stopped.content).not.toContain("has changes");
    expect(stopped.content).toContain("worktree cleanup FAILED");
    expect(warnings.join("\n")).not.toBe("");
    expect(existsSync(wtPath)).toBe(true);
    await twins.parent.dispose();
    await exec("git", ["-C", repo, "worktree", "unlock", wtPath]).catch(() => {});
    await rm(wtPath, { recursive: true, force: true }).catch(() => {});
  });

  it("existsSync 早退：目录被外部删除 → stop 仍清分支（第三条泄漏路径回归锚）", async () => {
    repo = await gitRepo();
    const twins = await worktreeWorld();
    const spawned = await spawnWorktree(twins);
    const agentId = agentIdOf(spawned.content);
    const wtEntry = (await readdir(worktreeParent(repo))).find((f) => f.includes(agentId)) ?? "";
    const wtPath = join(worktreeParent(repo), wtEntry);
    await rm(wtPath, { recursive: true, force: true });
    const stopped = await callTool({ world: twins.world, name: "task_stop", args: { task_id: agentId }, session: twins.parent.agent.session.id });
    expect(stopped.content).not.toContain("FAILED");
    const branches = await exec("git", ["-C", repo, "branch", "--list", `x-harness/${agentId}`]);
    expect(branches.stdout.trim()).toBe("");
    await twins.parent.dispose();
  });

  it("非 git 仓（workspaceRoot 指向）→ spawn-failed:worktree not-a-git-repo 且无残留分支", async () => {
    const dir = join(fixtureDir("plain"), "repo");
    mkdirSync(dir);
    scratch = [...scratch, dirname(dir)];
    const physical = realpathSync(dir);
    const options = await makeOptions({}, { workspaceRoot: physical, worktreeSweep: false });
    const world = await makeWorld(options, undefined, [grantsStub()]);
    const parent = await spawnParent(world, PARENT_MODEL, "wt-main" as SessionId);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
    const refused = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", isolation: "worktree" }, session: parent.agent.session.id });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("spawn-failed:worktree");
    expect(refused.content).toContain("not-a-git-repo");
    await parent.dispose();
  });

  it("workspaceRoot 在仓内子目录 → rev-parse 上溯仓根建树（合法通过）", async () => {
    repo = await gitRepo();
    const sub = join(repo, "pkg");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sub);
    const physical = realpathSync(repo);
    const options = await makeOptions({}, { workspaceRoot: sub, worktreeSweep: false });
    const world = await makeWorld(options, undefined, [grantsStub()]);
    const parent = await spawnParent(world, PARENT_MODEL, "wt-main" as SessionId);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", isolation: "worktree" }, session: parent.agent.session.id });
    expect(spawned.isError).toBeUndefined();
    const grants = world.ctx.tryUse(permissionGrants);
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [""])[1] as SessionId;
    expect(grants?.rootOverrideOf(childSession)?.guard).toBe(physical);
    await parent.dispose();
  });

  it("GIT_WORK_TREE 外指 → 仓顶落在工作区外 → workspace-not-in-repo 真拒绝（A 路复审②）", async () => {
    repo = await gitRepo();
    const elsewhere = join(fixtureDir("gwt"), "elsewhere");
    mkdirSync(elsewhere);
    scratch = [...scratch, dirname(elsewhere)];
    const prev = process.env["GIT_WORK_TREE"];
    process.env["GIT_WORK_TREE"] = elsewhere;
    try {
      const top = (await exec("git", ["-C", repo, "rev-parse", "--show-toplevel"])).stdout.trim();
      expect(top).toBe(realpathSync(elsewhere));
      const options = await makeOptions({}, { workspaceRoot: repo, worktreeSweep: false });
      const world = await makeWorld(options, undefined, [grantsStub()]);
      const parent = await spawnParent(world, PARENT_MODEL, "wt-main" as SessionId);
      world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
      const refused = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", isolation: "worktree" }, session: parent.agent.session.id });
      expect(refused.isError).toBe(true);
      expect(refused.content).toContain("workspace-not-in-repo");
      await parent.dispose();
    } finally {
      if (prev === undefined) delete process.env["GIT_WORK_TREE"];
      else process.env["GIT_WORK_TREE"] = prev;
    }
  });

  it("symlink 逻辑形 workspaceRoot（/var vs /private/var）不再被词法比较误拒——realpath 归一后仓内子目录合法", async () => {
    repo = await gitRepo();
    const logical = repo.replace("/private/var/", "/var/");
    if (logical === repo) {
      expect(true).toBe(true);
      return;
    }
    const options = await makeOptions({}, { workspaceRoot: logical, worktreeSweep: false });
    const world = await makeWorld(options, undefined, [grantsStub()]);
    const parent = await spawnParent(world, PARENT_MODEL, "wt-main" as SessionId);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", isolation: "worktree" }, session: parent.agent.session.id });
    expect(spawned.isError).toBeUndefined();
    await parent.dispose();
  });

  it("isolation 非法值 → invalid-args；grants 缺位 → worktree 拒（不半装）", async () => {
    repo = await gitRepo();
    const bad = await makeOptions({}, { workspaceRoot: repo, worktreeSweep: false });
    const worldNoGrants = await makeWorld(bad);
    const parent = await spawnParent(worldNoGrants);
    worldNoGrants.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
    const invalid = await callTool({ world: worldNoGrants, name: "agent_spawn", args: { description: "d", prompt: "x", isolation: "remote" }, session: parent.agent.session.id });
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toContain("invalid-args:isolation");
    const noGrants = await callTool({ world: worldNoGrants, name: "agent_spawn", args: { description: "d", prompt: "x", isolation: "worktree" }, session: parent.agent.session.id });
    expect(noGrants.isError).toBe(true);
    expect(noGrants.content).toContain("requires the permission grants service");
    const listed = await callTool({ world: worldNoGrants, name: "list_agents", args: {}, session: parent.agent.session.id });
    expect(listed.content).toContain("(no sub-agents)");
    expect(existsSync(worktreeParent(repo))).toBe(false);
    await parent.dispose();
  });

  it("git 串行队列：并发两 worktree spawn 均成且路径互异", async () => {
    repo = await gitRepo();
    const twins = await worktreeWorld();
    const [a, b] = await Promise.all([spawnWorktree(twins), spawnWorktree(twins)]);
    expect(a.isError).toBeUndefined();
    expect(b.isError).toBeUndefined();
    expect(agentIdOf(a.content)).not.toBe(agentIdOf(b.content));
    const entries = (await readdir(worktreeParent(repo))).filter((f) => f.includes(agentIdOf(a.content)) || f.includes(agentIdOf(b.content)));
    expect(entries).toHaveLength(2);
    await twins.parent.dispose();
  });

  it("启动期清扫：净树+分支被清、脏树保留（sweepWorktrees 直测，now 注入超龄）", async () => {
    repo = await gitRepo();
    const made = await createWorktree("agent-sweep01", repo);
    expect(made.ok).toBe(true);
    const dirty = await createWorktree("agent-sweep02", repo);
    expect(dirty.ok).toBe(true);
    if (dirty.ok) writeFileSync(join(dirty.plan.path, "CHANGE.md"), "x");
    const aged = (): number => Date.now() + 2 * 3_600_000;
    const kept = await sweepWorktrees([], repo, { now: aged });
    expect(kept).toHaveLength(1);
    expect(kept[0]?.kind).toBe("kept-dirty");
    if (made.ok) {
      expect(existsSync(made.plan.path)).toBe(false);
      const branches = await exec("git", ["-C", repo, "branch", "--list", "x-harness/agent-sweep01"]);
      expect(branches.stdout.trim()).toBe("");
    }
    if (dirty.ok) await rm(dirty.plan.path, { recursive: true, force: true }).catch(() => {});
  });

  it("新鲜树不清（FRESH_MS 窗内——同仓他进程在用工作树防线）", async () => {
    repo = await gitRepo();
    const made = await createWorktree("agent-fresh01", repo);
    expect(made.ok).toBe(true);
    const kept = await sweepWorktrees(liveTreePaths(), repo);
    expect(kept).toHaveLength(0);
    if (made.ok) expect(existsSync(made.plan.path)).toBe(true);
  });

  it("livePaths 活行不清（误删防线第一层——同进程在用工作树）", async () => {
    repo = await gitRepo();
    const made = await createWorktree("agent-live01", repo);
    expect(made.ok).toBe(true);
    const aged = (): number => Date.now() + 2 * 3_600_000;
    if (made.ok) {
      const kept = await sweepWorktrees([made.plan.path], repo, { now: aged });
      expect(kept).toHaveLength(0);
      expect(existsSync(made.plan.path)).toBe(true);
    }
  });

  it("teardown 级联：插件 dispose 清理子的 worktree（净树）", async () => {
    repo = await gitRepo();
    const twins = await worktreeWorld();
    const spawned = await spawnWorktree(twins);
    const agentId = agentIdOf(spawned.content);
    const wtEntry = (await readdir(worktreeParent(repo))).find((f) => f.includes(agentId)) ?? "";
    const wtPath = join(worktreeParent(repo), wtEntry);
    await twins.world.disposePlugins();
    await sleep(50);
    expect(existsSync(wtPath)).toBe(false);
  });

  it("兄弟仓的树不被本仓 sweep 评估（共享父目录——跨仓 remove 必败的永久假告警）", async () => {
    const parentDir = join(fixtureDir("sib"), "sib");
    mkdirSync(parentDir);
    scratch = [...scratch, dirname(parentDir)];
    const repoA = join(parentDir, "repoA");
    const repoB = join(parentDir, "repoB");
    for (const r of [repoA, repoB]) {
      await exec("git", ["-C", r, "init"]).catch(async () => {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(r);
        await exec("git", ["-C", r, "init"]);
      });
      await exec("git", ["-C", r, "config", "user.email", "t@t"]);
      await exec("git", ["-C", r, "config", "user.name", "t"]);
      writeFileSync(join(r, "README.md"), "seed\n");
      await exec("git", ["-C", r, "add", "."]);
      await exec("git", ["-C", r, "commit", "-m", "seed"]);
    }
    const physicalA = realpathSync(repoA);
    const made = await createWorktree("agent-sib01", physicalA);
    expect(made.ok).toBe(true);
    const aged = (): number => Date.now() + 2 * 3_600_000;
    const kept = await sweepWorktrees([], realpathSync(repoB), { now: aged });
    expect(kept).toHaveLength(0);
    if (made.ok) expect(existsSync(made.plan.path)).toBe(true);
    const own = await sweepWorktrees([], physicalA, { now: aged });
    expect(own).toHaveLength(0);
    if (made.ok) expect(existsSync(made.plan.path)).toBe(false);
  });

  it("进程级活树登记簿：registerLiveTree 后 sweep 不清（含跨装配实例形态）", async () => {
    repo = await gitRepo();
    const made = await createWorktree("agent-live02", repo);
    expect(made.ok).toBe(true);
    if (made.ok) {
      registerLiveTree(made.plan.path);
      const aged = (): number => Date.now() + 2 * 3_600_000;
      const kept = await sweepWorktrees(liveTreePaths(), repo, { now: aged });
      expect(kept).toHaveLength(0);
      expect(existsSync(made.plan.path)).toBe(true);
      unregisterLiveTree(made.plan.path);
      const after = await sweepWorktrees(liveTreePaths(), repo, { now: aged });
      expect(after).toHaveLength(0);
      expect(existsSync(made.plan.path)).toBe(false);
    }
  });

  it("kick 失败 → spawn 同步错误结果（非谎报成功）+ worktree 尽力清理 + 摘除登记（A 路三轮发现1 回归锚）", async () => {
    repo = await gitRepo();
    const warnings: string[] = [];
    const twins = await worktreeWorld({ onWarn: (m) => warnings.push(m) });
    const { kickChild } = await import("../spawn.ts");
    const plan = await createWorktree("agent-kick01", repo);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      registerLiveTree(plan.plan.path);
      const row: import("../lineage.ts").ChildRow = {
        agentId: "agent-kick01",
        sessionId: "s-kick" as SessionId,
        type: "untyped",
        parent: twins.parent.agent.session.id,
        depth: 1,
        occupied: true,
        armed: false,
        running: false,
        stopped: false,
        worktree: plan.plan.path,
        worktreeRepoTop: plan.plan.repoTop,
      };
      const sealing = {
        agent: {
          followup(): never {
            throw new Error("followup boom");
          },
        },
      } as never;
      const finished: unknown[] = [];
      const kickDeps = {
        onWarn: (m: string) => warnings.push(m),
        emitFinished: (p: unknown) => finished.push(p),
        workspaceRoot: repo,
      } as unknown as Parameters<typeof kickChild>[0];
      const outcome = await kickChild(kickDeps, { row, handle: sealing, prompt: "x" });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toContain("kick failed");
      expect(finished).toHaveLength(1);
      const wired = await (await import("../spawn.ts")).finishSpawn(kickDeps, { row, handle: sealing, prompt: "x", freshFork: false });
      expect(wired.ok).toBe(false);
      await sleep(100);
      expect(existsSync(plan.plan.path)).toBe(false);
      const branches = await exec("git", ["-C", repo, "branch", "--list", "x-harness/agent-kick01"]);
      expect(branches.stdout.trim()).toBe("");
      expect(liveTreePaths()).not.toContain(plan.plan.path);
    }
    await twins.parent.dispose();
  });

  it("路径形态：worktreeParent 在 repo 外同级（不落 .git 受保护区）", async () => {
    repo = await gitRepo();
    expect(worktreeParent(repo)).toBe(join(dirname(repo), ".x-harness-worktrees"));
    expect(worktreeParent(repo).startsWith(join(repo, ".git"))).toBe(false);
    expect(basename(worktreeParent(repo))).toBe(".x-harness-worktrees");
  });

  it("跨装配清理不漂移：spawn 落账行 → 换 workspaceRoot 装配 → task_stop 仍删对树（repoTop 持久化事实）", async () => {
    repo = await gitRepo();
    const twins = await worktreeWorld();
    const spawned = await spawnWorktree(twins);
    const agentId = agentIdOf(spawned.content);
    const wtEntry = (await readdir(worktreeParent(repo))).find((f) => f.includes(agentId)) ?? "";
    const wtPath = join(worktreeParent(repo), wtEntry);
    const elsewhere = join(fixtureDir("elsewhere"), "elsewhere");
    mkdirSync(elsewhere);
    scratch = [...scratch, dirname(elsewhere)];
    const second = await worktreeWorldAt(elsewhere);
    const stopped = await callTool({ world: second.world, name: "task_stop", args: { task_id: agentId }, session: twins.parent.agent.session.id });
    expect(stopped.isError).toBe(true);
    const stoppedHere = await callTool({ world: twins.world, name: "task_stop", args: { task_id: agentId }, session: twins.parent.agent.session.id });
    expect(stoppedHere.isError).toBeUndefined();
    expect(existsSync(wtPath)).toBe(false);
    const branches = await exec("git", ["-C", repo, "branch", "--list", `x-harness/${agentId}`]);
    expect(branches.stdout.trim()).toBe("");
    await twins.parent.dispose();
  });

  it("复活 worktree 的 repoTop 取主仓顶（.git gitdir 解析——非 worktree 自身）+ guard 同构 spawn 侧", async () => {
    repo = await gitRepo();
    const made = await createWorktree("agent-rev01", repo);
    expect(made.ok).toBe(true);
    if (made.ok) {
      const { readFile } = await import("node:fs/promises");
      const gitdir = (await readFile(join(made.plan.path, ".git"), "utf8")).trim();
      expect(gitdir.startsWith("gitdir: ")).toBe(true);
      expect(gitdir).toContain(repo);
      await evaluateCleanup(made.plan);
      expect(existsSync(made.plan.path)).toBe(false);
    }
  });
});

describe("per-repo lockfile（跨进程写互斥）", { timeout: 20_000 }, () => {
  it("互斥：持锁期间第二个临界区等待（串行执行）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xh-lock-"));
    scratch = [...scratch, dir];
    const order: string[] = [];
    const lock = join(dir, "repo-test.lock");
    let aExit: () => void = () => {};
    const aDone = new Promise<void>((resolve) => {
      aExit = resolve;
    });
    let aEnteredResolve: () => void = () => {};
    const aEntered = new Promise<void>((resolve) => {
      aEnteredResolve = resolve;
    });
    const first = withRepoLock(lock, async () => {
      order.push("a-start");
      aEnteredResolve();
      await aDone;
      order.push("a-end");
    });
    await aEntered;
    const second = withRepoLock(lock, async () => {
      order.push("b-start");
      order.push("b-end");
    });
    await sleep(30);
    expect(order).toEqual(["a-start"]);
    aExit();
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("stale 抢占：持锁 pid 死亡 → 后来者可抢", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xh-lock-stale-"));
    scratch = [...scratch, dir];
    const lock = join(dir, "repo-test.lock");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(lock);
    await writeFile(join(lock, "pid"), "999999999");
    let ran = false;
    await withRepoLock(lock, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("release 只删自己的锁（他者覆盖后不误删）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xh-lock-rel-"));
    scratch = [...scratch, dir];
    const lock = join(dir, "repo-test.lock");
    await withRepoLock(lock, async () => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(lock, "pid"), "12345");
    });
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(lock, "pid"), "utf8")).toBe("12345");
  });

  it("repoLockPath 确定性：同 repoTop 同路径、异 repoTop 异路径", () => {
    expect(repoLockPath("/tmp/wt", "/Users/x/repo")).toBe(repoLockPath("/tmp/wt", "/Users/x/repo"));
    expect(repoLockPath("/tmp/wt", "/Users/x/repo")).not.toBe(repoLockPath("/tmp/wt", "/Users/x/other"));
  });
});

describe("组合隔离（§8.2 工具参数面 × grants 子会话键——审查 A-P1-4 处置）", () => {
  it("worktree 子会话视角：worktree 路径放行、主仓路径拒、原根子树授权被过滤", async () => {
    repo = await gitRepo();
    const repoNow = repo;
    const twins = await worktreeWorld();
    const spawned = await spawnWorktree(twins);
    expect(spawned.isError).toBeUndefined();
    const agentId = agentIdOf(spawned.content);
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [""])[1] as SessionId;
    const wtEntry = (await readdir(worktreeParent(repo))).find((f) => f.includes(agentId)) ?? "";
    const wtPath = join(worktreeParent(repo), wtEntry);
    const { PathGate, admitSession } = await import("@x-harness/tool-core");
    const gate = new PathGate(repoNow);
    const rp = async (p: string) => p;
    const grants = twins.world.ctx.tryUse(permissionGrants);
    const overrideOf = (session: SessionId | undefined) => grants?.rootOverrideOf(session);
    const extraRootsOf = (session: SessionId | undefined) => (session === childSession ? [join(repoNow, "sub")] : []);
    const inside = await admitSession({ gate, realpath: rp, session: childSession, extraRootsOf, rootOverrideOf: overrideOf, target: join(wtPath, "file.ts") });
    expect(inside.ok).toBe(true);
    const outside = await admitSession({ gate, realpath: rp, session: childSession, extraRootsOf, rootOverrideOf: overrideOf, target: join(repoNow, "secret.ts") });
    expect(outside.ok).toBe(false);
    const viaGuarded = await admitSession({ gate, realpath: rp, session: childSession, extraRootsOf, rootOverrideOf: overrideOf, target: join(repoNow, "sub", "x.ts") });
    expect(viaGuarded.ok).toBe(false);
    const parentView = await admitSession({ gate, realpath: rp, session: twins.parent.agent.session.id, extraRootsOf, rootOverrideOf: overrideOf, target: join(repoNow, "secret.ts") });
    expect(parentView.ok).toBe(true);
    await twins.parent.dispose();
  });
});
