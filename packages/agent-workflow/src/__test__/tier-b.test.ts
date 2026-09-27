// Tier B 命令验收 + 让位协议 + 档组合单测（件16 §8.2/§9）：真实 sandbox 执行 exit code
// 裁决、verify intent-result 对、schema+command 组合链、task_stop 让位与迟到 miss 纪律。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "@x-harness/session";
import { sessionStore } from "@x-harness/session";
import { createPermissionPlugin } from "@x-harness/permission";
import { createSandboxPlugin } from "@x-harness/sandbox";
import { createTaskToolsPlugin } from "@x-harness/task-tools";
import type { Plugin } from "@x-harness/core";
import { createContext, loadPlugins } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { createAgentDelegationPlugin, delegationView } from "@x-harness/agent-delegation";
import { createAgentWorkflowPlugin } from "../plugin.ts";
import { commandVerdictOf } from "../runtime.ts";

beforeEach(() => {
  resetWorlds();
});

const disposers: Array<() => Promise<void>> = [];
function resetWorlds(): void {
  for (const dispose of disposers.splice(0)) void dispose();
}

interface Fixture {
  readonly submit: (input: Record<string, unknown>) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  readonly stopTask: (taskId: string, caller: SessionId | undefined) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  readonly texts: () => string;
  readonly view: import("@x-harness/agent-delegation").DelegationView;
  readonly ctx: ReturnType<typeof createContext>;
  readonly loop: import("@x-harness/agent-loop").AgentLoopService;
  readonly dispose: () => Promise<void>;
}

async function fixture(root: string, scripts: string[]): Promise<Fixture> {
  const buckets = new Map<string, AsyncGenerator<LlmChunk>[]>();
  buckets.set("parent-model", scripts.map((text) => script(text)));
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
    createAgentDelegationPlugin({ agentsDirs: [], workspaceRoot: root, worktreeSweep: false }),
    createAgentWorkflowPlugin({ userCommandOnly: false, root: join(root, "workflows"), mainSession: "main-1" as SessionId }),
  ];
  await loadPlugins(ctx, plugins);
  const loop = ctx.use(agentLoopServiceToken);
  const parent = await loop.create({ session: { id: "main-1" as SessionId }, agent: { model: "parent-model", provider: "fake" } });
  if (!parent.ok) throw new Error(parent.reason);
  const off = ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: async function* (request: LlmRequest): AsyncGenerator<LlmChunk> {
      const next = buckets.get(request.model)?.shift();
      for await (const chunk of next ?? script("unused")) yield chunk;
    },
  });
  ctx.effect(off);
  const registry = ctx.use((await import("@x-harness/tools")).toolRegistry);
  const view = ctx.use(delegationView);
  const dispose = async (): Promise<void> => {
    await parent.value.dispose();
    await ctx.dispose();
  };
  disposers.push(dispose);
  return {
    view,
    ctx,
    loop,
    submit: async (input) => {
      const made = await registry.dispatch({ callId: `t-${String(Math.random()).slice(2, 8)}`, name: "workflow_submit", args: input, signal: new AbortController().signal, session: "main-1" as SessionId });
      return made.isError === true ? { ok: false, reason: made.content } : { ok: true, text: made.content };
    },
    stopTask: async (taskId, caller) => {
      const made = await registry.dispatch({ callId: `s-${String(Math.random()).slice(2, 8)}`, name: "task_stop", args: { task_id: taskId }, signal: new AbortController().signal, ...(caller !== undefined ? { session: caller } : {}) });
      return made.isError === true ? { ok: false, reason: made.content } : { ok: true, text: made.content };
    },
    texts: () => ctx.use(sessionStore).get("main-1" as SessionId)?.events()
      .filter((event) => event.type === "agent/message" || event.type === "user/message")
      .map((event) => JSON.stringify(event.data)).join("\n") ?? "",
    dispose,
  };
}

function script(text: string): AsyncGenerator<LlmChunk> {
  return (async function* () {
    yield { type: "text-delta", text } as never;
    yield { type: "finish", finish: { kind: "stop" } } as never;
  })();
}

describe("Tier B 命令验收（真实沙箱 exit code）", () => {
  it("命令过 → command:accept 终局；verify intent-result 对落账", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-cmd-"));
    const sideEffect = join(root, "count.txt");
    const f = await fixture(root, ['{"title": "ok"}']);
    const sent = await f.submit({ description: "cmd task", prompt: "work", result_schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } }, acceptance: { command: `echo side >> ${sideEffect} && true` } });
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => expect(f.texts()).toContain("workflow-notification"), { timeout: 15_000 });
    expect(f.texts()).toContain("passed"); // schema 过 + 命令 exit 0 → 链全过
    const { readdir } = await import("node:fs/promises");
    const runs = await readdir(join(root, "workflows"));
    const journal = await readFile(join(root, "workflows", runs[0] ?? "", "journal.jsonl"), "utf8");
    expect(journal).toContain("verify/started");
    expect(journal).toContain('"outcome":"passed"');
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("命令 exit≠0 → 回炉（反馈含输出尾）→ 修复后过（计数文件确定性自愈——无 writeFile 竞争）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-cmd2-"));
    const countFile = join(root, "runs.count");
    // 命令自身计数：第 1 次 exit 1（写计数）、第 2 次起 exit 0——回炉轮必然过，无时序竞争
    const command = `n=$(cat ${countFile} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${countFile}; test $n -ge 2`;
    const f = await fixture(root, [
      '{"title": "first"}', // 首轮：命令第 1 次跑 → exit 1 → 回炉
      '{"title": "fixed"}', // 回炉轮：命令第 2 次跑 → exit 0 → 过
    ]);
    const sent = await f.submit({ description: "repair me", prompt: "x", acceptance: { command } });
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => expect(f.texts()).toContain("workflow-notification"), { timeout: 15_000 });
    expect(f.texts()).toContain("finished: passed"); // G4 修：断言修复成功终态（非仅通知到达）
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("commandVerdictOf 三值：passed/预算耗尽/reject", () => {
    expect(commandVerdictOf({ outcome: "passed" }, { used: 0, max: 3 })).toEqual({ kind: "accept" });
    const fail = commandVerdictOf({ outcome: "failed", exitCode: 2 }, { used: 2, max: 3 });
    expect(fail.kind).toBe("fail");
    const reject = commandVerdictOf({ outcome: "failed", exitCode: 1 }, { used: 0, max: 3 });
    expect(reject.kind).toBe("reject");
  });
});

describe("task_stop 让位协议（§9）", () => {
  it("受管行让位 workflow 源：task_stop 停 run（agent 源 miss 续走）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-stop-"));
    const f = await fixture(root, ["working very long "]);
    const sent = await f.submit({ description: "stoppable", prompt: "x", result_schema: { type: "object" } });
    expect(sent.ok).toBe(true);
    const agentId = (sent.ok ? sent.text.match(/agent-[0-9a-f]{8}/)?.[0] : "") ?? "";
    expect(agentId).not.toBe("");
    // taskId 从 submit 文本提取（A8：runId 前缀化——不再硬编码 t1）
    const taskId = sent.ok ? (sent.text.match(/taskId: (\S+) /)?.[1] ?? "") : "";
    expect(taskId).not.toBe("");
    const stopped = await f.stopTask(taskId, "main-1" as SessionId);
    expect(stopped.ok).toBe(true);
    expect(stopped.ok === true && stopped.text).toContain("run settled: cancelled");
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("迟到 miss 纪律：未知 task_id 的 reason 以 not-found: 开头", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-miss-"));
    const f = await fixture(root, ["x"]);
    const miss = await f.stopTask("t-nonexistent", "main-1" as SessionId);
    expect(miss.ok).toBe(false);
    expect(miss.ok === false && miss.reason).toMatch(/not-found:/);
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

describe("acceptor-command 边界", () => {
  it("execEnv 缺席 → verify unknown（不炸）；closeDanglingVerify 落 unknown result", async () => {
    const { runAcceptanceCommand, closeDanglingVerify } = await import("../acceptor-command.ts");
    const { openRunJournal, workflowPluginVersion } = await import("../journal.ts");
    const root = await mkdtemp(join(tmpdir(), "xh-wf-ac-"));
    const { createContext } = await import("@x-harness/core");
    const ctx = createContext(); // 无任何插件——execEnv tryUse miss
    const made = await openRunJournal(join(root, "workflows"), { runId: "r-ac", parentSession: "s", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
    if (made.kind !== "opened") throw new Error("fixture");
    const { step } = await import("@x-harness/workflow-core");
    let snapshot = step({ runId: "r-ac", parentSession: "s", cwd: root, status: "created" as const, tasks: {}, notified: new Set<string>(), consecutiveFailures: 0 }, { type: "run/created", runId: "r-ac", parentSession: "s", cwd: root });
    snapshot = step(snapshot, { type: "task/submitted", taskId: "t1", spec: { description: "d", prompt: "p" } });
    const run = { header: made.header, writer: made.writer, snapshot };
    const outcome = await runAcceptanceCommand({ ctx, run, taskId: "t1", attempt: 1, command: "true", childSession: "s-child" as never });
    expect(outcome.outcome).toBe("unknown");
    expect(outcome.outputTail).toContain("unavailable");
    await closeDanglingVerify(run, "t1", 2);
    const journal = await readFile(join(root, "workflows", "r-ac", "journal.jsonl"), "utf8");
    expect(journal).toContain("verify/started");
    expect(journal).toContain('"outcome":"unknown"');
    await made.writer.close();
    await rm(root, { recursive: true, force: true });
  });
});

describe("acceptor-command spawn 失败分支", () => {
  it("cwd 无效 → spawn failed → verify unknown（intent-result 对完整落账）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-badcwd-"));
    const world = await fixture(root, ['{"t":1}']);
    const { runAcceptanceCommand } = await import("../acceptor-command.ts");
    const { openRunJournal, workflowPluginVersion } = await import("../journal.ts");
    const { step } = await import("@x-harness/workflow-core");
    const made = await openRunJournal(join(root, "workflows"), { runId: "r-bad", parentSession: "main-1", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
    if (made.kind !== "opened") throw new Error("fixture");
    let snapshot = step({ runId: "r-bad", parentSession: "main-1", cwd: root, status: "created" as const, tasks: {}, notified: new Set<string>(), consecutiveFailures: 0 }, { type: "run/created", runId: "r-bad", parentSession: "main-1", cwd: root });
    snapshot = step(snapshot, { type: "task/submitted", taskId: "t1", spec: { description: "d", prompt: "p" } });
    const run = { header: made.header, writer: made.writer, snapshot };
    const outcome = await runAcceptanceCommand({ ctx: world.ctx, run, taskId: "t1", attempt: 1, command: "true", cwdOverride: "/nonexistent-cwd-xyz", childSession: "main-1" as never });
    expect(outcome.outcome).toBe("unknown");
    expect(outcome.outputTail).toContain("verify spawn failed");
    await made.writer.close();
    await world.dispose();
    await rm(root, { recursive: true, force: true });
  });
});
