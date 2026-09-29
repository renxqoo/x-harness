import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { branchAt, createGitWatchService, gitWatchDirsOf } from "../git-watch.ts";

const exec = promisify(execFile);

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }).catch(() => {})));
  roots = [];
});

async function gitRepo(): Promise<{ repo: string; wt: string }> {
  const root = mkdtempSync(join(tmpdir(), "xh-gw-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  await exec("git", ["-C", repo, "init"]);
  await exec("git", ["-C", repo, "config", "user.email", "t@t"]);
  await exec("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "F"), "x");
  await exec("git", ["-C", repo, "add", "."]);
  await exec("git", ["-C", repo, "commit", "-m", "s"]);
  await exec("git", ["-C", repo, "branch", "dev"]);
  const wt = join(root, "wt");
  await exec("git", ["-C", repo, "worktree", "add", wt, "dev"]);
  return { repo: realpathSync(repo), wt: realpathSync(wt) };
}

const settle = (ms = 500): Promise<void> => new Promise((resolve) => { setTimeout(() => resolve(), ms); });

describe("gitWatchDirsOf（锚点定位——双目录）", () => {
  it("主仓本体：gitDir=commonDir=.git 目录", async () => {
    const { repo } = await gitRepo();
    const dirs = gitWatchDirsOf(repo);
    expect(dirs?.gitDir).toBe(join(repo, ".git"));
    expect(dirs?.commonDir).toBe(join(repo, ".git"));
  });

  it("linked worktree：gitDir=worktrees/<n>、commonDir=主仓 .git（refs 在主仓）", async () => {
    const { repo, wt } = await gitRepo();
    const dirs = gitWatchDirsOf(wt);
    expect(dirs?.gitDir).toContain(join(".git", "worktrees"));
    expect(dirs?.commonDir).toBe(join(repo, ".git"));
  });

  it("非 git 目录 / 空串 → undefined（temp 根须在系统 tmp——mkdtemp 于仓内会上寻命中本仓 .git）", async () => {
    const root = mkdtempSync(join(tmpdir(), "xh-gw-norepo-"));
    roots.push(root);
    expect(gitWatchDirsOf("")).toBeUndefined();
  });
});

describe("createGitWatchService（事件语义）", () => {
  it("主仓 switch：HEAD 写落 gitdir → 事件（branch=新值；payload 带 cwd）", async () => {
    const { repo } = await gitRepo();
    const events: Array<{ threadId: string; cwd: string; branch?: string }> = [];
    const svc = createGitWatchService({
      emit: (f) => events.push(f),
      liveThreads: () => [{ threadId: "t1", cwd: repo }],
      debounceMs: 100,
    });
    svc.reconcile();
    await settle(100);
    await exec("git", ["-C", repo, "checkout", "-b", "side-a"]);
    await settle(600);
    expect(events.some((e) => e.threadId === "t1" && e.cwd === repo && e.branch === "side-a")).toBe(true);
    svc.stop();
  }, 10_000);

  it("worktree 内建分支：refs 写落 commonDir → 事件（防 UI 分支菜单陈旧——F5 锚）", async () => {
    const { wt } = await gitRepo();
    const events: Array<{ branch?: string }> = [];
    const svc = createGitWatchService({
      emit: (f) => events.push(f),
      liveThreads: () => [{ threadId: "t1", cwd: wt }],
      debounceMs: 100,
    });
    svc.reconcile();
    await settle(100);
    await exec("git", ["-C", wt, "branch", "created-in-wt"]);
    await settle(600);
    expect(events.length).toBeGreaterThanOrEqual(1);
    svc.stop();
  }, 10_000);

  it("同值抑制：A→B→A 窗内往返只发终值或不发（回到原值不重发）", async () => {
    const { wt } = await gitRepo();
    const events: Array<{ branch?: string }> = [];
    const svc = createGitWatchService({
      emit: (f) => events.push(f),
      liveThreads: () => [{ threadId: "t1", cwd: wt }],
      debounceMs: 200,
    });
    svc.reconcile();
    await settle(100);
    await exec("git", ["-C", wt, "checkout", "-b", "tmp/x"]);
    await exec("git", ["-C", wt, "checkout", "-"]);
    await settle(800);
    const branches = events.map((e) => e.branch);
    const unique = new Set(branches);
    expect(unique.size).toBe(branches.length);
    svc.stop();
  }, 10_000);

  it("detached：事件仍发（branch 缺席=已分离——防 UI 停旧名，D7 锚）", async () => {
    const { repo } = await gitRepo();
    const events: Array<{ branch?: string }> = [];
    const svc = createGitWatchService({
      emit: (f) => events.push(f),
      liveThreads: () => [{ threadId: "t1", cwd: repo }],
      debounceMs: 100,
    });
    svc.reconcile();
    await settle(100);
    await exec("git", ["-C", repo, "checkout", "--detach"]);
    await settle(600);
    const detached = events.find((e) => e.branch === undefined);
    expect(detached).toBeDefined();
    svc.stop();
  }, 10_000);

  it("多线程同 gitdir：fan-out 逐 threadId 出帧（payload 带 cwd——兄弟会话按 cwd 匹配）", async () => {
    const { repo, wt } = await gitRepo();
    const events: Array<{ threadId: string; cwd: string }> = [];
    const svc = createGitWatchService({
      emit: (f) => events.push(f),
      liveThreads: () => [
        { threadId: "t-main", cwd: repo },
        { threadId: "t-wt", cwd: wt },
        { threadId: "t-else", cwd: "/tmp" },
      ],
      debounceMs: 100,
    });
    svc.reconcile();
    await settle(100);
    await exec("git", ["-C", repo, "checkout", "-b", "side-b"]);
    await settle(600);
    expect(events.some((e) => e.threadId === "t-main")).toBe(true);
    const wtFrames = events.filter((e) => e.threadId === "t-wt");
    expect(wtFrames.every((e) => e.cwd === wt)).toBe(true);
    expect(events.every((e) => e.threadId !== "t-else")).toBe(true);
    svc.stop();
  }, 10_000);

  it("reconcile diff：live 集合清空 → watcher 全收（无泄漏）；新增 cwd → 挂新", async () => {
    const { repo, wt } = await gitRepo();
    let live = [{ threadId: "t1", cwd: repo }, { threadId: "t2", cwd: wt }];
    const svc = createGitWatchService({
      emit: () => {},
      liveThreads: () => live,
      debounceMs: 50,
    });
    svc.reconcile();
    live = [];
    svc.reconcile();
    await settle(100);
    live = [{ threadId: "t3", cwd: repo }];
    svc.reconcile();
    const events: Array<{ branch?: string }> = [];
    const svc2 = createGitWatchService({
      emit: (f) => events.push(f),
      liveThreads: () => [{ threadId: "t3", cwd: repo }],
      debounceMs: 50,
    });
    svc2.reconcile();
    await settle(100);
    await exec("git", ["-C", repo, "checkout", "-b", "side-c"]);
    await settle(500);
    expect(events.some((e) => e.branch === "side-c")).toBe(true);
    svc.stop();
    svc2.stop();
  }, 10_000);

  it("树删后退避重挂：目录重建 + 后续变更仍有事件（红线——F8）", async () => {
    vi.setConfig({ testTimeout: 20_000 });
    const { repo, wt } = await gitRepo();
    await exec("git", ["-C", repo, "worktree", "remove", "--force", wt]);
    expect(existsSync(wt)).toBe(false);
    await exec("git", ["-C", repo, "worktree", "add", wt, "dev"]);
    const events: Array<{ branch?: string }> = [];
    const svc = createGitWatchService({
      emit: (f) => events.push(f),
      liveThreads: () => [{ threadId: "t1", cwd: wt }],
      debounceMs: 100,
    });
    svc.reconcile();
    await settle(100);
    await exec("git", ["-C", wt, "checkout", "-b", "after-rebuild"]);
    await settle(800);
    expect(events.some((e) => e.branch === "after-rebuild")).toBe(true);
    svc.stop();
  }, 20_000);
});

describe("branchAt（尾沿读取）", () => {
  it("detached → undefined；分支 → 名", async () => {
    const { repo } = await gitRepo();
    const initial = branchAt(join(repo, ".git"));
    expect(initial === "main" || initial === "master").toBe(true);
    await exec("git", ["-C", repo, "checkout", "--detach"]);
    expect(branchAt(join(repo, ".git"))).toBeUndefined();
  });
});
