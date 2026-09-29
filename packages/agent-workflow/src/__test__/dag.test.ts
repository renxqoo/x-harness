import { describe, expect, it } from "vitest";
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
import { createAgentWorkflowPlugin } from "../plugin.ts";
import { dependencyVerdict, readiness } from "@x-harness/workflow-core";
import type { RunSnapshot, TaskState } from "@x-harness/workflow-core";

function script(text: string): AsyncGenerator<LlmChunk> {
  return (async function* () {
    yield { type: "text-delta", text } as never;
    yield { type: "finish", finish: { kind: "stop" } } as never;
  })();
}

const taskOf = (plan: { readonly taskId: string; readonly dependsOn?: readonly string[]; readonly status?: TaskState["status"]; readonly outcome?: "completed" | "failed" }): TaskState =>
  ({ taskId: plan.taskId, spec: { description: "d", prompt: "p", ...(plan.dependsOn !== undefined ? { dependsOn: plan.dependsOn } : {}) }, status: plan.status ?? "submitted", repairs: 0, reopens: 0, verifyAttempts: 0, trailing: [], ...(plan.outcome !== undefined ? { outcome: plan.outcome } : {}) });

const snapshotOf = (tasks: Readonly<Record<string, TaskState>>): RunSnapshot =>
  ({ runId: "r", parentSession: "s", cwd: "/", status: "created", tasks, notified: new Set<string>(), consecutiveFailures: 0 });

describe("dependencyVerdict 四值（真 depsOn）", () => {
  const tasks: Readonly<Record<string, TaskState>> = {
    done: taskOf({ taskId: "done", status: "settled", outcome: "completed" }),
    failed: taskOf({ taskId: "failed", status: "settled", outcome: "failed" }),
    pending: taskOf({ taskId: "pending", status: "dispatched" }),
  };
  it("无依赖 ready / 未终态 waiting / 失败终态 doomed / 悬空 orphan / 全完成 ready", () => {
    expect(dependencyVerdict([], tasks)).toBe("ready");
    expect(dependencyVerdict(["pending"], tasks)).toBe("waiting");
    expect(dependencyVerdict(["failed"], tasks)).toBe("doomed");
    expect(dependencyVerdict(["ghost"], tasks)).toBe("orphan");
    expect(dependencyVerdict(["done"], tasks)).toBe("ready");
  });

  it("readiness：doomed/orphan 进 dependencyDoomed；waiting 不派发", () => {
    const snap = snapshotOf({
      failed: taskOf({ taskId: "failed", status: "settled", outcome: "failed" }),
      pending: taskOf({ taskId: "pending", status: "dispatched" }),
      a: taskOf({ taskId: "a", dependsOn: ["failed"] }),
      b: taskOf({ taskId: "b", dependsOn: ["ghost"] }),
      c: taskOf({ taskId: "c", dependsOn: ["pending"] }),
      d: taskOf({ taskId: "d" }),
    });
    const result = readiness(snap, { maxInFlight: 10, circuitBreak: 0 });
    expect(result.dependencyDoomed).toEqual(["a", "b"]);
    expect(result.dispatchable).toEqual(["d"]);
  });
});

describe("提交校验（期 2-C）", () => {
  it("depends_on 空条目/重复拒", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-dag1-"));
    const ctx = createContext();
    const plugins: readonly Plugin[] = [
      sessionPlugin, toolsPlugin, systemPromptPlugin, llmPlugin, agentLoopPlugin, createTaskToolsPlugin(),
      createAgentDelegationPlugin({ agentsDirs: [], workspaceRoot: root, worktreeSweep: false }),
      createAgentWorkflowPlugin({ userCommandOnly: false, root: join(root, "workflows"), mainSession: "main-1" as SessionId }),
    ];
    await loadPlugins(ctx, plugins);
    const loop = ctx.use(agentLoopServiceToken);
    const parent = await loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "m", provider: "fake" } });
    if (!parent.ok) throw new Error(parent.reason);
    const registry = ctx.use(toolRegistry);
    const submit = async (input: Record<string, unknown>) => {
      const made = await registry.dispatch({ callId: "t", name: "workflow_submit", args: input, signal: new AbortController().signal, session: "main-1" as SessionId });
      return made.isError === true ? { ok: false as const, reason: made.content } : { ok: true as const, text: made.content };
    };
    const dup = await submit({ description: "d", prompt: "p", result_schema: { type: "object" }, depends_on: ["t-x", "t-x"] });
    expect(dup.ok).toBe(false);
    expect(dup.ok === false && dup.reason).toContain("duplicate");
    const empty = await submit({ description: "d", prompt: "p", result_schema: { type: "object" }, depends_on: [""] });
    expect(empty.ok === false && empty.reason).toContain("non-empty");
    await parent.value.dispose();
    await ctx.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

describe("悬空依赖提交拒（期 2 单任务 run 语义）", () => {
  it("跨 run 悬空 depends_on：提交即拒 invalid-args（多任务 run 开放后转 run 内图校验）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-dag2-"));
    const ctx = createContext();
    const plugins: readonly Plugin[] = [
      sessionPlugin, toolsPlugin, systemPromptPlugin, llmPlugin, agentLoopPlugin, createTaskToolsPlugin(),
      createAgentDelegationPlugin({ agentsDirs: [], workspaceRoot: root, worktreeSweep: false }),
      createAgentWorkflowPlugin({ userCommandOnly: false, root: join(root, "workflows"), mainSession: "main-1" as SessionId }),
    ];
    await loadPlugins(ctx, plugins);
    const loop = ctx.use(agentLoopServiceToken);
    const scripts = new Map<string, AsyncGenerator<LlmChunk>[]>();
    scripts.set("m", [script("deliverable text")]);
    const off = ctx.use(llmRuntime).registerAdapter({
      name: "fake",
      stream: async function* (request: LlmRequest): AsyncGenerator<LlmChunk> {
        for await (const chunk of scripts.get(request.model)?.shift() ?? script("")) yield chunk;
      },
    });
    ctx.effect(off);
    const parent = await loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "m", provider: "fake" } });
    if (!parent.ok) throw new Error(parent.reason);
    const registry = ctx.use(toolRegistry);
    const made = await registry.dispatch({ callId: "d1", name: "workflow_submit", args: { description: "dep task", prompt: "x", depends_on: ["t-ghost-run-task"] }, signal: new AbortController().signal, session: "main-1" as SessionId });
    expect(made.isError).toBe(true);
    expect(String(made.content)).toContain("not resolvable");
    await parent.value.dispose();
    await ctx.dispose();
    await rm(root, { recursive: true, force: true });
  }, 25_000);
});
