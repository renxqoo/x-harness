import { describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { systemPrompt, systemPromptPlugin } from "@x-harness/system-prompt";
import { agentSpawned } from "@x-harness/agent-delegation";
import { createBasePromptPlugin } from "../base-prompt.ts";
import { createWorktreeContextPlugin } from "../worktree-context.ts";

const FACTS = { cwd: "/w/main", isGit: true, platform: "darwin", shell: "zsh" } as const;
const WT = "/wt/x-harness-agent-0123abcd";

describe("dispose 回卷序（LIFO）下 worktree-context 先卸、system-prompt 后卸", () => {
  it("unload(worktree-context) 单独卸载：层本体一并摘除（off() 调 system-prompt 注册表——此刻存活）", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      systemPromptPlugin,
      createBasePromptPlugin(FACTS),
      createWorktreeContextPlugin({ facts: FACTS }),
    ]);
    const prompt = ctx.use(systemPrompt);
    ctx.emit(agentSpawned, { parent: "p" as never, agentId: "a", sessionId: "c1" as never, type: "untyped", depth: 1, worktree: WT, branch: "b1" });
    expect(prompt.assemble({ sessionId: "c1" }).text).toContain(WT);
    await unload[2]!();
    expect(prompt.assemble({ sessionId: "c1" }).text).not.toContain(WT);
    expect(prompt.assemble().text).toContain("You are xh");
    await ctx.dispose();
  });

  it("unload(system-prompt) 单独卸载（反序形态）：worktree-context 的 off() 落在已卸注册表上不炸", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      systemPromptPlugin,
      createBasePromptPlugin(FACTS),
      createWorktreeContextPlugin({ facts: FACTS }),
    ]);
    ctx.emit(agentSpawned, { parent: "p" as never, agentId: "a", sessionId: "c1" as never, type: "untyped", depth: 1, worktree: WT, branch: "b1" });
    await unload[0]!();
    await unload[2]!();
    expect(true).toBe(true);
    await ctx.dispose();
  });

  it("ctx.dispose 整体回卷（生产主路径）：无异常 + 幂等", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [
      systemPromptPlugin,
      createBasePromptPlugin(FACTS),
      createWorktreeContextPlugin({ facts: FACTS }),
    ]);
    ctx.emit(agentSpawned, { parent: "p" as never, agentId: "a", sessionId: "c1" as never, type: "untyped", depth: 1, worktree: WT, branch: "b1" });
    await ctx.dispose();
    await ctx.dispose();
    expect(true).toBe(true);
  });
});
