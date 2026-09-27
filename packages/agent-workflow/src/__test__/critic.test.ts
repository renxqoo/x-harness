// Tier C critic 评审验收测试（期 2-B）：提案解析（W5 自举 schema 校验）+ 链序（schema→critic）
// + reopen 回炉（critic fail → steer 修复 → critic pass）+ 预算耗尽 + critic 产出无效回炉。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "@x-harness/session";
import type { Plugin } from "@x-harness/core";
import { createContext, loadPlugins } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { createTaskToolsPlugin } from "@x-harness/task-tools";
import { createAgentDelegationPlugin } from "@x-harness/agent-delegation";
import { createAgentWorkflowPlugin, workflowView } from "../plugin.ts";
import { CRITIC_PROPOSAL_SCHEMA, criticDispatchPrompt, criticEvidence, parseCriticProposal } from "../acceptor-critic.ts";

beforeEach(() => {
  resetWorlds();
});

const disposers: Array<() => Promise<void>> = [];
function resetWorlds(): void {
  for (const dispose of disposers.splice(0)) void dispose();
}


/**
 * 装置：worker 类型 = critic（model 同桶——脚本按调用次序供给：任务子 1 轮 → critic 1 轮 → …）
 * 桶序（链：schema→critic）——submit 后依次消耗：[任务首轮, critic#1, (任务修复轮), critic#2, ...]
 */

function script(text: string): AsyncGenerator<LlmChunk> {
  return (async function* () {
    yield { type: "text-delta", text } as never;
    yield { type: "finish", finish: { kind: "stop" } } as never;
  })();
}

describe("提案解析（W5 自举）", () => {
  it("合格提案过（pass/fail 各一）", () => {
    const pass = parseCriticProposal('{"verdict":"pass"}');
    expect("proposal" in pass && pass.proposal.verdict).toBe("pass");
    const fail = parseCriticProposal('```json\n{"verdict":"fail","reopenProposals":["fix auth flow","add test"]}\n```');
    expect("proposal" in fail && fail.proposal.reopenProposals).toEqual(["fix auth flow", "add test"]);
  });

  it("schema 违规拒（verdict 缺席/enum 外/非 JSON）", () => {
    expect("invalid" in parseCriticProposal('{"summary":"no verdict"}')).toBe(true);
    expect("invalid" in parseCriticProposal('{"verdict":"maybe"}')).toBe(true);
    expect("invalid" in parseCriticProposal("no json here")).toBe(true);
  });

  it("criticEvidence 映射（pass→无提案/fail→提案）", () => {
    expect(criticEvidence({ verdict: "pass", reopenProposals: [] })).toMatchObject({ kind: "critic", verdict: "pass" });
    const ev = criticEvidence({ verdict: "fail", reopenProposals: ["x"] });
    expect(ev.kind === "critic" && ev.reopenProposals).toEqual(["x"]);
  });

  it("dispatch prompt 含 schema 与任务/交付物", () => {
    const p = criticDispatchPrompt({ deliverable: "DELIV", originalTask: "TASK" });
    expect(p).toContain("DELIV");
    expect(p).toContain("TASK");
    expect(p).toContain("verdict");
  });

  it("CRITIC_PROPOSAL_SCHEMA 冻结形状", () => {
    expect(CRITIC_PROPOSAL_SCHEMA.properties.verdict.enum).toEqual(["pass", "fail"]);
  });
});

describe("Tier C 链序（schema→critic 全旅程）", () => {
  it("critic 全旅程：任务交付→critic fail(提案)→steer 修复→critic pass→passed", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-c2-"));
    const scripts = new Map<string, AsyncGenerator<LlmChunk>[]>();
    scripts.set("critic-model", [
      script('{"verdict":"fail","reopenProposals":["deliverable must mention ZED"]}'),
      script('{"verdict":"pass"}'),
    ]);
    scripts.set("task-model", [script("I made a thing"), script("Now with ZED inside")]);
    const ctx = createContext();
    const plugins: readonly Plugin[] = [
      sessionPlugin, toolsPlugin, systemPromptPlugin, llmPlugin, agentLoopPlugin, createTaskToolsPlugin(),
      createAgentDelegationPlugin({ agentsDirs: [join(root, "agents")], workspaceRoot: root, worktreeSweep: false }),
      createAgentWorkflowPlugin({ userCommandOnly: false, root: join(root, "workflows"), mainSession: "main-1" as SessionId }),
    ];
    const { mkdir: mk, writeFile: wf2 } = await import("node:fs/promises");
    await mk(join(root, "agents"), { recursive: true });
    await wf2(join(root, "agents", "reviewer.md"), `---\nname: reviewer\ndescription: test critic\nmodel: critic-model\n---\nYou review deliverables.`);
    await loadPlugins(ctx, plugins);
    const loop = ctx.use(agentLoopServiceToken);
    const off = ctx.use(llmRuntime).registerAdapter({
      name: "fake",
      stream: async function* (request: LlmRequest): AsyncGenerator<LlmChunk> {
        for await (const chunk of scripts.get(request.model)?.shift() ?? script("")) yield chunk;
      },
    });
    ctx.effect(off);
    const parent = await loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "task-model", provider: "fake" } });
    if (!parent.ok) throw new Error(parent.reason);
    const registry = ctx.use(toolRegistry);
    const made = await registry.dispatch({ callId: "wc1", name: "workflow_submit", args: { description: "reviewed work", prompt: "produce deliverable", critic: { type: "reviewer" } }, signal: new AbortController().signal, session: "main-1" as SessionId });
    expect(made.isError).toBeUndefined();
    const { sessionStore } = await import("@x-harness/session");
    const texts = () => ctx.use(sessionStore).get("main-1" as SessionId)?.events().filter((e) => e.type === "user/message" || e.type === "agent/message").map((e) => JSON.stringify(e.data)).join("\n") ?? "";
    await vi.waitFor(() => expect(texts()).toContain("workflow-notification"), { timeout: 15_000 });
    expect(texts()).toContain("passed"); // critic 二轮 pass
    await parent.value.dispose();
    await ctx.dispose();
    await rm(root, { recursive: true, force: true });
  }, 25_000);

  it("预算耗尽：critic 恒 fail → 终局 failed（reopens 上限）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-c3-"));
    const scripts = new Map<string, AsyncGenerator<LlmChunk>[]>();
    scripts.set("critic-model", Array.from({ length: 4 }, () => script('{"verdict":"fail","reopenProposals":["still wrong"]}')));
    scripts.set("task-model", Array.from({ length: 4 }, (_, i) => script(`attempt ${String(i)}`)));
    const ctx = createContext();
    const plugins: readonly Plugin[] = [
      sessionPlugin, toolsPlugin, systemPromptPlugin, llmPlugin, agentLoopPlugin, createTaskToolsPlugin(),
      createAgentDelegationPlugin({ agentsDirs: [join(root, "agents")], workspaceRoot: root, worktreeSweep: false }),
      createAgentWorkflowPlugin({ userCommandOnly: false, root: join(root, "workflows"), mainSession: "main-1" as SessionId,  budget: { repairs: 1, reopens: 1, verifyAttempts: 1 } }),
    ];
    const { mkdir: mk, writeFile: wf2 } = await import("node:fs/promises");
    await mk(join(root, "agents"), { recursive: true });
    await wf2(join(root, "agents", "reviewer.md"), `---\nname: reviewer\ndescription: test critic\nmodel: critic-model\n---\nYou review deliverables.`);
    await loadPlugins(ctx, plugins);
    const loop = ctx.use(agentLoopServiceToken);
    const off = ctx.use(llmRuntime).registerAdapter({
      name: "fake",
      stream: async function* (request: LlmRequest): AsyncGenerator<LlmChunk> {
        for await (const chunk of scripts.get(request.model)?.shift() ?? script("")) yield chunk;
      },
    });
    ctx.effect(off);
    const parent = await loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "task-model", provider: "fake" } });
    if (!parent.ok) throw new Error(parent.reason);
    const registry = ctx.use(toolRegistry);
    const made = await registry.dispatch({ callId: "wc3", name: "workflow_submit", args: { description: "doomed", prompt: "x", critic: { type: "reviewer" } }, signal: new AbortController().signal, session: "main-1" as SessionId });
    expect(made.isError).toBeUndefined();
    const { sessionStore } = await import("@x-harness/session");
    const texts = () => ctx.use(sessionStore).get("main-1" as SessionId)?.events().filter((e) => e.type === "user/message" || e.type === "agent/message").map((e) => JSON.stringify(e.data)).join("\n") ?? "";
    await vi.waitFor(() => expect(texts()).toContain("workflow-notification"), { timeout: 15_000 });
    // R1 回归锚：reopens 预算耗尽终局（budget-exhausted）——非脚本耗尽的 child-failed 碰巧形态
    expect(texts()).toContain("critic:budget-exhausted");
    await parent.value.dispose();
    await ctx.dispose();
    await rm(root, { recursive: true, force: true });
  }, 25_000);
});

describe("rebind 后 critic 可用（R2 回归：caller 曾用冻结 deps.mainSession → not-found 死循环）", () => {
  it("切会话后 critic 任务正常评审（派发 caller = 活会话）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-r2c-"));
    const scripts = new Map<string, AsyncGenerator<LlmChunk>[]>();
    scripts.set("critic-model", [script('{"verdict":"pass"}')]);
    scripts.set("task-model", [script("the deliverable")]);
    const ctx = createContext();
    const { mkdir: mk2, writeFile: wf3 } = await import("node:fs/promises");
    await mk2(join(root, "agents"), { recursive: true });
    await wf3(join(root, "agents", "reviewer.md"), `---\nname: reviewer\ndescription: critic\nmodel: critic-model\n---\nYou review.`);
    const plugins: readonly Plugin[] = [
      sessionPlugin, toolsPlugin, systemPromptPlugin, llmPlugin, agentLoopPlugin, createTaskToolsPlugin(),
      createAgentDelegationPlugin({ agentsDirs: [join(root, "agents")], workspaceRoot: root, worktreeSweep: false }),
      createAgentWorkflowPlugin({ userCommandOnly: false, root: join(root, "workflows"), mainSession: "old-sess" as SessionId }),
    ];
    await loadPlugins(ctx, plugins);
    const loop = ctx.use(agentLoopServiceToken);
    const off = ctx.use(llmRuntime).registerAdapter({
      name: "fake",
      stream: async function* (request: LlmRequest): AsyncGenerator<LlmChunk> {
        for await (const chunk of scripts.get(request.model)?.shift() ?? script("")) yield chunk;
      },
    });
    ctx.effect(off);
    // rebind 到新会话（旧会话从未建——直接迁）
    await workflowViewPluginRebind(ctx, "new-sess" as SessionId);
    const parent = await loop.create({ session: { id: "new-sess" as SessionId }, agent: { model: "task-model", provider: "fake" } });
    if (!parent.ok) throw new Error(parent.reason);
    const registry = ctx.use(toolRegistry);
    const made = await registry.dispatch({ callId: "r2c", name: "workflow_submit", args: { description: "post-rebind critic", prompt: "x", critic: { type: "reviewer" } }, signal: new AbortController().signal, session: "new-sess" as SessionId });
    expect(made.isError).toBeUndefined();
    const { sessionStore } = await import("@x-harness/session");
    const texts = () => ctx.use(sessionStore).get("new-sess" as SessionId)?.events().filter((e) => e.type === "user/message" || e.type === "agent/message").map((e) => JSON.stringify(e.data)).join("\n") ?? "";
    await vi.waitFor(() => expect(texts()).toContain("workflow-notification"), { timeout: 15_000 });
    expect(texts()).toContain("passed"); // critic pass（活 caller 派发成功）
    await parent.value.dispose();
    await ctx.dispose();
    await rm(root, { recursive: true, force: true });
  }, 25_000);

  async function workflowViewPluginRebind(ctx: ReturnType<typeof createContext>, next: SessionId): Promise<void> {
    const view = ctx.tryUse(workflowView);
    const rebound = await view?.rebind(next);
    if (rebound !== undefined && !rebound.ok) throw new Error(rebound.reason);
  }
});
