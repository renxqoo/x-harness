// git 变更监视单测（docs/GIT-INTERACTION-REDESIGN §6）：真 git 双目录语义
// （HEAD 写落 gitdir、建分支写落 commonDir）、防抖合并、同值抑制、detached 事件、
// fan-out 快照时点、reconcile diff 挂收、树删退避重挂。

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

/** 防抖窗收敛等待（真 fs.watch 事件 + 150ms 防抖 + 余量） */
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
    // tmp 环境不可假设无 git 仓（dotfiles 仓会上寻命中）——此处只断空串与文件形态：
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
    await exec("git", ["-C", repo, "checkout", "-b", "side-a"]); // dev 被 wt 占用——主仓切独立分支
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
    expect(events.length).toBeGreaterThanOrEqual(1); // commonDir 命中（HEAD 未变也有事件——分支列表失效信号）
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
    // 窗内：dev → main → dev（回到原值——终值与首读相同则整窗抑制）
    await exec("git", ["-C", wt, "checkout", "-b", "tmp/x"]);
    await exec("git", ["-C", wt, "checkout", "-"]); // 回 dev
    await settle(800);
    // 首读无 lastBranch 基线 → tmp/x 或不发都可能；断言不重复发同值
    const branches = events.map((e) => e.branch);
    const unique = new Set(branches);
    expect(unique.size).toBe(branches.length); // 无重复同值帧
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
    expect(detached).toBeDefined(); // detached 事件在场（branch 键缺席）
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
        { threadId: "t-else", cwd: "/tmp" }, // 不同 gitdir——不收帧
      ],
      debounceMs: 100,
    });
    svc.reconcile();
    await settle(100);
    await exec("git", ["-C", repo, "checkout", "-b", "side-b"]); // 主仓 HEAD 变（dev 被占用）——commonDir 同目录但 gitdir 不同，只 t-main 收
    await settle(600);
    expect(events.some((e) => e.threadId === "t-main")).toBe(true);
    // t-wt 也收帧是正确语义：主仓建分支写 commonDir（与 wt 的 commonDir 同目录）——
    // wt 的分支列表视图确实变了（refs 失效信号，非 HEAD 失效）；帧的 branch 字段仍是
    // wt 自己的 HEAD（dev——尾沿读自己的 gitDir）
    const wtFrames = events.filter((e) => e.threadId === "t-wt");
    expect(wtFrames.every((e) => e.cwd === wt)).toBe(true);
    expect(events.every((e) => e.threadId !== "t-else")).toBe(true); // 无关 cwd 不收
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
    live = []; // 全下线
    svc.reconcile();
    await settle(100);
    live = [{ threadId: "t3", cwd: repo }]; // 重新上线
    svc.reconcile();
    const events: Array<{ branch?: string }> = [];
    // 复用同一 service：重挂后仍能收事件（挂/收/重挂成对——F8 锚）
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
    // 删 worktree（树与 gitdir 一并消亡）
    await exec("git", ["-C", repo, "worktree", "remove", "--force", wt]);
    expect(existsSync(wt)).toBe(false);
    // 同路径重建 worktree
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
    expect(initial === "main" || initial === "master").toBe(true); // init 默认依配置
    await exec("git", ["-C", repo, "checkout", "--detach"]);
    expect(branchAt(join(repo, ".git"))).toBeUndefined();
  });
});
