// git 事实探测单测（docs/WORKTREE-CONTEXT-AWARENESS §1.1/§5）：表驱动手造 .git 形态
// （零 git 二进制——真 git 形态留 e2e worktree 旅程）；D7 存在性前置与键省略降级。

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeGitFacts } from "../base-prompt-probe.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "xh-gitfacts-"));
}

describe("probeGitFacts（主仓本体形态——.git 目录）", () => {
  it("ref 行 → branch", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(probeGitFacts(root)).toEqual({ branch: "main" });
  });

  it("子目录上寻命中（游走）", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/feat/x\n");
    expect(probeGitFacts(join(root, "a", "b"))).toEqual({ branch: "feat/x" });
  });

  it("detached HEAD（40hex）→ 键省略", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "4a1b2c3d4e5f60718293a4b5c6d7e8f901234567\n");
    expect(probeGitFacts(root)).toEqual({});
  });

  it("HEAD 垃圾文本 → 键省略", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "nonsense");
    expect(probeGitFacts(root)).toEqual({});
  });

  it("HEAD 不可读（造成目录 → EISDIR）→ 键省略", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git", "HEAD"), { recursive: true });
    expect(probeGitFacts(root)).toEqual({});
  });

  it("无 .git（游走到根不命中）→ 双键省略", () => {
    const root = tempRoot();
    expect(probeGitFacts(root)).toEqual({});
  });
});

describe("probeGitFacts（linked worktree 形态——.git file）", () => {
  it("gitdir 解析 → branch（gitdir/HEAD）+ worktreeMain（worktrees 段前缀）", () => {
    const root = tempRoot();
    mkdirSync(join(root, "main", ".git", "worktrees", "agent-01"), { recursive: true });
    mkdirSync(join(root, "wt-a"));
    writeFileSync(join(root, "wt-a", ".git"), `gitdir: ${join(root, "main", ".git", "worktrees", "agent-01")}\n`);
    writeFileSync(join(root, "main", ".git", "worktrees", "agent-01", "HEAD"), "ref: refs/heads/x-harness/agent-01\n");
    expect(probeGitFacts(join(root, "wt-a"))).toEqual({ branch: "x-harness/agent-01", worktreeMain: join(root, "main") });
  });

  it("gitdir 指向不存在路径 → branch 省（HEAD 不可读）、worktreeMain 仍在（段前缀是字符串事实——分支与归属解耦）", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".git"), "gitdir: /nonexistent/xyz/.git/worktrees/a\n");
    expect(probeGitFacts(root)).toEqual({ worktreeMain: "/nonexistent/xyz" });
  });

  it("gitdir 无 worktrees 段（submodule 形态）→ branch 在、worktreeMain 省（分支与归属解耦）", () => {
    const root = tempRoot();
    mkdirSync(join(root, "mod"), { recursive: true });
    writeFileSync(join(root, ".git"), `gitdir: ${join(root, "mod")}\n`);
    writeFileSync(join(root, "mod", "HEAD"), "ref: refs/heads/sub-branch\n");
    expect(probeGitFacts(root)).toEqual({ branch: "sub-branch" });
  });

  it(".git file 无 gitdir 行（垃圾）→ 双键省略", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".git"), "not a pointer\n");
    expect(probeGitFacts(root)).toEqual({});
  });
});

describe("probeGitFacts（D7 存在性前置）", () => {
  it("cwd 不存在 → {}（防向上游走命中无关祖先仓——worktree 被删后的误显示回归锚）", () => {
    expect(probeGitFacts(join(tmpdir(), "xh-gitfacts-definitely-missing-9z"))).toEqual({});
  });

  it("cwd 是文件（非目录）→ {}", () => {
    const root = tempRoot();
    const file = join(root, "f.txt");
    writeFileSync(file, "x");
    expect(probeGitFacts(file)).toEqual({});
  });
});
