// worktree 子环境块单测（docs/WORKTREE-CONTEXT-AWARENESS.md §1.4 Track N）：
// named 子 systemPrompt 拼接（类型正文 + 环境块）、键缺席省略行、双缺席仍渲染目录行。

import { describe, expect, it } from "vitest";
import { appendWorktreeEnv, worktreeEnvBlock } from "../worktree-env.ts";

describe("worktreeEnvBlock（环境块全文）", () => {
  it("全事实：目录行 + 分支行 + 主仓行", () => {
    const text = worktreeEnvBlock({ path: "/wt/x-harness-agent-01", facts: { branch: "x-harness/agent-01", worktreeMain: "/repo" } });
    expect(text).toContain("- Working directory: /wt/x-harness-agent-01");
    expect(text).toContain("- Git branch: x-harness/agent-01");
    expect(text).toContain("- Main repository (read-only reference, outside your sandbox): /repo");
    expect(text).toContain("isolated git worktree");
  });

  it("facts 缺席（树 .git 不可读）：目录行仍在、主仓行 unknown——工作区事实不依赖 git 可读性", () => {
    const text = worktreeEnvBlock({ path: "/wt/x", facts: undefined });
    expect(text).toContain("- Working directory: /wt/x");
    expect(text).not.toContain("- Git branch:");
    expect(text).toContain("): unknown");
  });

  it("branch 缺席（detached）省略行、worktreeMain 缺席（submodule 形态）unknown——键缺席=未知", () => {
    const text = worktreeEnvBlock({ path: "/wt/x", facts: { worktreeMain: "/repo" } });
    expect(text).not.toContain("- Git branch:");
    expect(text).toContain("- Main repository (read-only reference, outside your sandbox): /repo");
    const detached = worktreeEnvBlock({ path: "/wt/x", facts: { branch: "x-harness/agent-01" } });
    expect(detached).toContain("- Git branch: x-harness/agent-01");
    expect(detached).toContain("): unknown");
  });

  it("空串 facts 键（垃圾降级——空串视同缺席）", () => {
    const text = worktreeEnvBlock({ path: "/wt/x", facts: { branch: "", worktreeMain: "" } });
    expect(text).not.toContain("- Git branch: ");
    expect(text).toContain("): unknown");
  });
});

describe("appendWorktreeEnv（类型正文拼接）", () => {
  it("正文 + 块（双换行分隔）", () => {
    const text = appendWorktreeEnv("You are a search specialist.", { path: "/wt/x", facts: { branch: "b" } });
    expect(text.startsWith("You are a search specialist.\n\n")).toBe(true);
    expect(text).toContain("- Working directory: /wt/x");
  });

  it("正文空 → 块独立成文（无前导换行）", () => {
    const text = appendWorktreeEnv("", { path: "/wt/x", facts: undefined });
    expect(text.startsWith("## Environment")).toBe(true);
  });
});
