import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Plugin } from "@x-harness/core";
import { sessionPlugin } from "@x-harness/session";
import { toolsPlugin } from "@x-harness/tools";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { llmPlugin } from "@x-harness/llm";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { createTaskToolsPlugin } from "@x-harness/task-tools";
import { createPermissionPlugin } from "@x-harness/permission";
import { createSandboxPlugin } from "@x-harness/sandbox";
import { runAcceptanceCommand } from "../acceptor-command.ts";
import { openRunJournal, workflowPluginVersion } from "../journal.ts";
import { step } from "@x-harness/workflow-core";

async function fixture(root: string): Promise<{ ctx: ReturnType<typeof createContext>; teardown: () => Promise<void> }> {
  const ctx = createContext();
  const plugins: readonly Plugin[] = [
    sessionPlugin,
    toolsPlugin,
    systemPromptPlugin,
    llmPlugin,
    agentLoopPlugin,
    createTaskToolsPlugin(),
    createPermissionPlugin({ root, mode: "full" as const }),
    createSandboxPlugin({ root }),
  ];
  const unload = await loadPlugins(ctx, plugins);
  const loop = ctx.use(agentLoopServiceToken);
  const parent = await loop.create({ session: { id: "main-1" as never }, agent: { model: "m", provider: "fake" } });
  if (!parent.ok) throw new Error(parent.reason);
  return {
    ctx,
    teardown: async () => {
      await parent.value.dispose();
      for (let i = unload.length - 1; i >= 0; i--) await unload[i]!();
      await ctx.dispose();
    },
  };
}

async function runWithTask(plan: { readonly root: string; readonly ctx: ReturnType<typeof createContext>; readonly command: string; readonly timeoutMs?: number; readonly outputLimit?: number }) {
  const { root, ctx, command } = plan;
  const made = await openRunJournal(join(root, "workflows"), { runId: "r-d8", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
  if (made.kind !== "opened") throw new Error("fixture");
  let snapshot = step({ runId: "r-d8", parentSession: "main-1", cwd: root, status: "created" as const, tasks: {}, notified: new Set<string>(), consecutiveFailures: 0 }, { type: "run/created", runId: "r-d8", parentSession: "main-1", cwd: root });
  snapshot = step(snapshot, { type: "task/submitted", taskId: "t1", spec: { description: "d", prompt: "p" } });
  const run = { header: made.header, writer: made.writer, snapshot };
  const outcome = await runAcceptanceCommand({ ctx, run, taskId: "t1", attempt: 1, command, childSession: "main-1" as never, ...(plan.timeoutMs !== undefined ? { timeoutMs: plan.timeoutMs } : {}), ...(plan.outputLimit !== undefined ? { outputLimit: plan.outputLimit } : {}) });
  return { outcome, writer: made.writer, run };
}

describe("Tier B 资源边界（D8）", () => {
  it("超时：死循环命令 500ms 窗 → failed + timeout 文案（两段杀收敛）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-d8a-"));
    const f = await fixture(root);
    const { outcome, writer } = await runWithTask({ root, ctx: f.ctx, command: "while :; do :; done", timeoutMs: 500 });
    expect(outcome.outcome).toBe("failed");
    expect(outcome.outputTail).toContain("timed out");
    await writer.close();
    await f.teardown();
    await rm(root, { recursive: true, force: true });
  }, 15_000);

  it("输出上限：>limit 字节输出 → 截断标记 + 采集停止（内存有界）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-d8b-"));
    const f = await fixture(root);
    const { outcome, writer } = await runWithTask({ root, ctx: f.ctx, command: "yes 0123456789 | head -c 300000; true", outputLimit: 100_000 });
    expect(outcome.outputTail).toContain("[output capped at 100000 bytes]");
    await writer.close();
    await f.teardown();
    await rm(root, { recursive: true, force: true });
  }, 15_000);
});
