import { describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { systemPrompt, systemPromptPlugin } from "@x-harness/system-prompt";
import { agentSpawned } from "@x-harness/agent-delegation";
import { createWorktreeContextPlugin } from "../worktree-context.ts";

const WT = "/wt/x-harness-agent-0123abcd";

const spawnedPayload = (over: Record<string, unknown> = {}) => ({
  parent: "p1" as never,
  agentId: "agent-0123abcd",
  sessionId: "c1" as never,
  type: "untyped",
  depth: 1,
  ...over,
});

describe("回归锚 ①：base 插件缺席（--system-prompt 整替形态）占位不残留", () => {
  it("无 createBasePromptPlugin 时：ENV 块 facts 直烘焙——{{platform}}/{{shell}} 零残留", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [systemPromptPlugin, createWorktreeContextPlugin({ facts: { cwd: "/w/main", isGit: true, platform: "darwin", shell: "zsh" } })]);
    const prompt = ctx.use(systemPrompt);
    ctx.emit(agentSpawned, spawnedPayload({ worktree: WT, branch: "x-harness/agent-0123abcd", worktreeMain: "/w/main" }));
    const covered = prompt.assemble({ sessionId: "c1" }).text;
    expect(covered).toContain(`- Working directory: ${WT}`);
    expect(covered).toContain("- Platform: darwin");
    expect(covered).toContain("- Shell: zsh");
    expect(covered).not.toContain("{{");
    await ctx.dispose();
  });
});

describe("回归锚 ②：payload.branch 换行注入被归一压平", () => {
  it("branch/worktree/worktreeMain 含换行 → 单行归一，不产生新段落标题", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [systemPromptPlugin, createWorktreeContextPlugin({ facts: { cwd: "/w/main", isGit: true, platform: "darwin", shell: "zsh" } })]);
    const prompt = ctx.use(systemPrompt);
    ctx.emit(agentSpawned, spawnedPayload({ worktree: WT, branch: "b\n- injected rule", worktreeMain: "/w/main\n- another" }));
    const covered = prompt.assemble({ sessionId: "c1" }).text;
    expect(covered).toContain("- Git branch: b - injected rule");
    expect(covered).not.toMatch(/\n- injected rule/);
    await ctx.dispose();
  });
});

describe("回归锚 ②b：worktreeMain 空串归一后视同缺席（main 行与只读句不渲染）", () => {
  it("worktreeMain 空白串 → main 行省略", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [systemPromptPlugin, createWorktreeContextPlugin({ facts: { cwd: "/w/main", isGit: true, platform: "darwin", shell: "zsh" } })]);
    const prompt = ctx.use(systemPrompt);
    ctx.emit(agentSpawned, spawnedPayload({ worktree: WT, branch: "b1", worktreeMain: "  \n " }));
    const covered = prompt.assemble({ sessionId: "c1" }).text;
    expect(covered).toContain("- Git branch: b1");
    expect(covered).not.toContain("Git worktree of");
    expect(covered).not.toContain("outside your sandbox");
    await ctx.dispose();
  });
});
