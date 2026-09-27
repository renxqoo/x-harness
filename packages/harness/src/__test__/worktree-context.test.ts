// Track U 覆盖插件单测（docs/WORKTREE-CONTEXT-AWARENESS §1.4/§5）：三面断言——
// 子会话 assemble 含 worktree 行且不含根层 cwd；根层 fingerprint 发射前后不变；
// payload 缺字段不注册。gone/sessionDisposed 摘层。装置：ctx.emit 直发
// agentSpawned（先例 bridge-units.test.ts——无需 delegation 插件在场）。

import { describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { systemPrompt, systemPromptPlugin } from "@x-harness/system-prompt";
import { sessionDisposed } from "@x-harness/session";
import { agentSpawned, agentWorktreeGone } from "@x-harness/agent-delegation";
import { createBasePromptPlugin } from "../base-prompt.ts";
import { createWorktreeContextPlugin } from "../worktree-context.ts";
import type { BasePromptFacts } from "../base-prompt.ts";

const FACTS: BasePromptFacts = { cwd: "/w/main-repo", isGit: true, platform: "darwin", shell: "zsh" };
const WT = "/wt/x-harness-agent-0123abcd";

async function rig(): Promise<{ ctx: ReturnType<typeof createContext>; prompt: import("@x-harness/system-prompt").SystemPromptService }> {
  const ctx = createContext();
  await loadPlugins(ctx, [systemPromptPlugin, createBasePromptPlugin(FACTS), createWorktreeContextPlugin({ facts: FACTS })]);
  return { ctx, prompt: ctx.use(systemPrompt) };
}

const spawnedPayload = (over: Record<string, unknown> = {}) => ({
  parent: "p1" as never,
  agentId: "agent-0123abcd",
  sessionId: "c1" as never,
  type: "untyped",
  depth: 1,
  ...over,
});

describe("createWorktreeContextPlugin（Track U 会话层覆盖）", () => {
  it("agentSpawned 三字段在场 → 子会话 base/core 被会话层顶替：含 worktree/branch/main 行、不含根层 cwd；根层 fingerprint 不变", async () => {
    const { ctx, prompt } = await rig();
    const before = prompt.assemble();
    ctx.emit(agentSpawned, spawnedPayload({ worktree: WT, branch: "x-harness/agent-0123abcd", worktreeMain: "/w/main-repo" }));
    const covered = prompt.assemble({ sessionId: "c1" });
    expect(covered.text).toContain(`- Working directory: ${WT}`);
    expect(covered.text).toContain("- Git branch: x-harness/agent-0123abcd");
    expect(covered.text).toContain("- Git worktree of: /w/main-repo");
    expect(covered.text).toContain("outside your sandbox"); // 只读参照句
    expect(covered.text).not.toContain("- Working directory: /w/main-repo"); // 根层 cwd 不出现（变量插值后）
    expect(covered.text).toContain("You are Agent"); // 守则/上下文管理/输出格式与根层同源（整段覆盖非 ENV 独段）
    // 根层零污染：文本与指纹逐字节不变
    const after = prompt.assemble();
    expect(after.text).toBe(before.text);
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it("主会话（无覆盖）assemble 不受影响", async () => {
    const { ctx, prompt } = await rig();
    ctx.emit(agentSpawned, spawnedPayload({ worktree: WT, branch: "x-harness/agent-0123abcd" }));
    expect(prompt.assemble().text).toContain("- Working directory: /w/main-repo"); // 根层插值照常
    expect(prompt.assemble({ sessionId: "other" }).text).not.toContain(WT);
  });

  it("payload 缺 worktree → 不注册；worktree 在场但缺 branch（detached HEAD）→ 覆盖层仍注册、分支行省略", async () => {
    const { ctx, prompt } = await rig();
    ctx.emit(agentSpawned, spawnedPayload({ branch: "b" })); // 缺 worktree
    expect(prompt.assemble({ sessionId: "c1" }).text).not.toContain("Git branch: b");
    ctx.emit(agentSpawned, spawnedPayload({ worktree: "", branch: "b" })); // 空串视同缺席
    expect(prompt.assemble({ sessionId: "c1" }).text).not.toContain("Git branch: b");
    // detached HEAD 树：目录行是底线事实——子必须知道自己在 worktree（回归锚：审查缺口）
    ctx.emit(agentSpawned, spawnedPayload({ worktree: WT }));
    const detached = prompt.assemble({ sessionId: "c1" }).text;
    expect(detached).toContain(`- Working directory: ${WT}`);
    expect(detached).not.toContain("Git branch:");
    expect(detached).toContain("You are Agent"); // 全量 base/core 仍在
  });

  it("worktreeMain 缺席（submodule/不可读）→ worktree 行与只读句省略、目录行仍在", async () => {
    const { ctx, prompt } = await rig();
    ctx.emit(agentSpawned, spawnedPayload({ worktree: WT, branch: "b1" }));
    const covered = prompt.assemble({ sessionId: "c1" });
    expect(covered.text).toContain(`- Working directory: ${WT}`);
    expect(covered.text).toContain("- Git branch: b1");
    expect(covered.text).not.toContain("Git worktree of");
    expect(covered.text).not.toContain("outside your sandbox");
  });

  it("agentWorktreeGone → 摘层回根层文本（stop removed 分支——树删会话驻留）", async () => {
    const { ctx, prompt } = await rig();
    ctx.emit(agentSpawned, spawnedPayload({ worktree: WT, branch: "b1" }));
    expect(prompt.assemble({ sessionId: "c1" }).text).toContain(WT);
    ctx.emit(agentWorktreeGone, { sessionId: "c1" as never, agentId: "agent-0123abcd" });
    expect(prompt.assemble({ sessionId: "c1" }).text).not.toContain(WT); // 回根层
  });

  it("sessionDisposed → 层清（system-prompt dropLayer 主路径 + 本插件登记表清理）", async () => {
    const { ctx, prompt } = await rig();
    ctx.emit(agentSpawned, spawnedPayload({ worktree: WT, branch: "b1" }));
    expect(prompt.assemble({ sessionId: "c1" }).text).toContain(WT);
    ctx.emit(sessionDisposed, { session: "c1" as never });
    expect(prompt.assemble({ sessionId: "c1" }).text).not.toContain(WT);
  });

  it("复活再发（同 sessionId）→ 幂等换层不双发", async () => {
    const { ctx, prompt } = await rig();
    ctx.emit(agentSpawned, spawnedPayload({ worktree: WT, branch: "b1" }));
    ctx.emit(agentSpawned, spawnedPayload({ worktree: WT, branch: "b2" })); // 分支漂移（复活预解析）
    const covered = prompt.assemble({ sessionId: "c1" });
    expect(covered.text).toContain("- Git branch: b2");
    expect(covered.text).not.toContain("- Git branch: b1"); // 旧层已摘——不双发
  });

  it("worktreeMain 空串（垃圾）视同缺席：worktree 行与只读句省略", async () => {
    const { ctx, prompt } = await rig();
    ctx.emit(agentSpawned, spawnedPayload({ worktree: WT, branch: "b1", worktreeMain: "" }));
    const covered = prompt.assemble({ sessionId: "c1" });
    expect(covered.text).toContain("- Git branch: b1");
    expect(covered.text).not.toContain("Git worktree of");
  });
});
