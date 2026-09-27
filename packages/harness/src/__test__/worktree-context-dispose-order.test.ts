// 对抗审查红测（7c16b4e harness 面·第 3 批）：dispose 回卷序下的层清理竞态。
// loadPlugins 的 unload 是 LIFO（后装先卸）：装配序 [system-prompt, base-prompt,
// worktree-context] → 卸载序 worktree-context → base-prompt → system-prompt。
// worktree-context 的 disposer 先 off 三个事件监听、再手动调 layers 里的 off()——
// 这些 off() 是 prompt.scoped().section() 的注销器，操作的是 system-prompt 注册表
// （此刻仍存活——system-prompt 最后卸）→ 无竞态。本批验证 ctx.dispose 全序 + 单插件
// unload 单独调用两个形态。

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
    // unload[2] = worktree-context（LIFO 首位）——卸载后层必须消失
    await unload[2]!();
    expect(prompt.assemble({ sessionId: "c1" }).text).not.toContain(WT);
    // 根层不受影响
    expect(prompt.assemble().text).toContain("You are Agent");
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
    // 逆 LIFO 人为调用（异常序形态——健壮性核实）：system-prompt 先卸（注册表闭包仍持 Map，
    // off() 仍可安全执行——闭包形态无「服务已死」面）
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
    await ctx.dispose(); // 幂等
    expect(true).toBe(true);
  });
});
