// 对抗审查红测（审查对象 7c16b4e packages/harness 面）——三个攻击面已证实并回填，
// 本文件保留为回归锚（攻击面 3 / 2 / 2b 的修复形态断言）：
// ① --system-prompt 整替形态：base 插件缺席但 delegationKit 仍装配 worktree 覆盖插件
//    → 覆盖段曾用 {{platform}}/{{shell}} 占位且无变量注册者 → 残留原文进子 system。
//    修复：ENV 块 facts 直烘焙（不走 interpolate）。
// ② 锚缺失降级：worktreeCoreText 曾返回「根层 facts 版全文」（cwd={{cwd}} 占位 +
//    gitBranch=worktree 分支的混合体——静默错误）。修复：锚缺失 → 放弃覆盖（不注册）。
//    注意：覆盖文本由本插件自己以 baseCoreText(covered) 生成（锚恒在场）——宿主自定义
//    base/core 段形态下，覆盖层会用 harness 版全文顶替宿主段（同名顶替是 registry
//    契约），锚防御只对 baseCoreText 自身文本漂移生效。
// ③ payload.branch 未过归一（含换行）→ 覆盖段渲染出多行伪造段落标题（提示词注入）。
//    修复：worktreeEnvironmentBlock 三字段 inline 归一。

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
    expect(covered).toContain("- Git branch: b - injected rule"); // 压平非丢弃——事实仍真
    expect(covered).not.toMatch(/\n- injected rule/); // 不作独立段落行
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
