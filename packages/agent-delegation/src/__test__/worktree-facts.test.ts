// worktree git 事实纯函数单测（docs/WORKTREE-CONTEXT-AWARENESS.md §1.1/§1.2）：
// .git file gitdir 解析、gitdir → 主仓顶、HEAD 文本 → 分支——字符串表驱动（零 IO）。

import { describe, expect, it } from "vitest";
import { branchOfHeadText, parseWorktreeGitdir, worktreeMainOfGitdir } from "../worktree-facts.ts";

describe("parseWorktreeGitdir（.git file 文本 → gitdir）", () => {
  it("标准形态：gitdir: <path> 单行", () => {
    expect(parseWorktreeGitdir("gitdir: /repo/.git/worktrees/agent-01\n")).toEqual({ gitdir: "/repo/.git/worktrees/agent-01" });
  });

  it("CRLF 行尾与尾空白容忍（git 产物形态差异）", () => {
    expect(parseWorktreeGitdir("gitdir: /repo/.git/worktrees/agent-01\r\n")).toEqual({ gitdir: "/repo/.git/worktrees/agent-01" });
    expect(parseWorktreeGitdir("gitdir: /repo/.git/worktrees/agent-01  ")).toEqual({ gitdir: "/repo/.git/worktrees/agent-01" });
  });

  it("多行文本中命中 gitdir 行（行首锚——前导空白不匹配）", () => {
    expect(parseWorktreeGitdir("garbage\ngitdir: /a/.git/worktrees/x\nmore")).toEqual({ gitdir: "/a/.git/worktrees/x" });
    expect(parseWorktreeGitdir("garbage\n gitdir: /a/.git/worktrees/x\nmore")).toBeUndefined(); // 行首空格非 git 产物形态
  });

  it("无 gitdir 行（.git 目录读出的内容/坏文件）→ undefined", () => {
    expect(parseWorktreeGitdir("not a pointer")).toBeUndefined();
    expect(parseWorktreeGitdir("")).toBeUndefined();
  });

  it("gitdir 空路径 → undefined（垃圾降级）", () => {
    expect(parseWorktreeGitdir("gitdir: ")).toBeUndefined();
  });
});

describe("worktreeMainOfGitdir（gitdir → 主仓顶）", () => {
  it("linked worktree 形态：段前缀即主仓顶", () => {
    expect(worktreeMainOfGitdir("/repo/.git/worktrees/agent-01")).toBe("/repo");
  });

  it("多段路径（主仓名含斜杠不可现——路径中段含 worktrees 字串时取末次命中）", () => {
    expect(worktreeMainOfGitdir("/repo/.git/worktrees/nested/.git/worktrees/agent-02")).toBe("/repo/.git/worktrees/nested");
  });

  it("submodule 形态（/.git/modules/x——无 worktrees 段）→ undefined：分支事实独立于归属", () => {
    expect(worktreeMainOfGitdir("/repo/.git/modules/sub-x")).toBeUndefined();
  });

  it("空串 → undefined", () => {
    expect(worktreeMainOfGitdir("")).toBeUndefined();
  });
});

describe("branchOfHeadText（HEAD 文本 → 分支名）", () => {
  it("ref: refs/heads/<branch> → branch", () => {
    expect(branchOfHeadText("ref: refs/heads/main\n")).toBe("main");
  });

  it("分支名含斜杠（feature/x-y）合法", () => {
    expect(branchOfHeadText("ref: refs/heads/feat/worktree-context\n")).toBe("feat/worktree-context");
  });

  it("CRLF 容忍", () => {
    expect(branchOfHeadText("ref: refs/heads/main\r\n")).toBe("main");
  });

  it("detached HEAD（40hex）→ undefined", () => {
    expect(branchOfHeadText("4a1b2c3d4e5f60718293a4b5c6d7e8f901234567\n")).toBeUndefined();
  });

  it("垃圾文本 → undefined", () => {
    expect(branchOfHeadText("ref: refs/remote/x\n")).toBeUndefined(); // 非 heads
    expect(branchOfHeadText("nonsense")).toBeUndefined();
    expect(branchOfHeadText("")).toBeUndefined();
  });
});
