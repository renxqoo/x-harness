// task 级 deadline 的 TDD 全谱（先红后绿）：挂起类三形态 + 交互/边界/迟到/恢复/重绑。
// ① child 挂起 ② critic 挂起 ③ 快任务对照（防误伤）④ 回炉慢打转 ⑤ 验收命令挂起
// ⑥ 迟到结算不复活 ⑦ 终局后 stop 幂等 ⑧ dispose 先于 deadline（钉子）⑩ 恢复路径挂起 ⑪ rebind 后触发。

import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "@x-harness/session";
import { sessionStore } from "@x-harness/session";
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
import { createPermissionPlugin } from "@x-harness/permission";
import { createSandboxPlugin } from "@x-harness/sandbox";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { createAgentWorkflowPlugin, workflowView } from "../plugin.ts";
import { craftInterruptedTask } from "./craft-interrupted.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(() => {
    resolve();
  }, ms);
});

function textScript(text: string, delayMs = 0): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    if (delayMs > 0) await sleep(delayMs);
    yield { type: "text-delta", text } as never;
    yield { type: "finish", finish: { kind: "stop" } } as never;
  })();
}

/** 伪挂起流：首 chunk 喂狗后永挂——不触发上游流静默看门狗（挂起类核心形态） */
function hangingStream(hangMs = 60_000): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LkmChunk | LlmChunk> {
    yield { type: "text-delta", text: "started" } as never;
    await sleep(hangMs);
    yield { type: "finish", finish: { kind: "stop" } } as never;
  })();
}

function neverStream(): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    await sleep(60_000);
    yield { type: "finish", finish: { kind: "stop" } } as never;
  })();
}

type LkmChunk = LlmChunk;

interface Fixture {
  readonly ctx: ReturnType<typeof createContext>;
  readonly loop: import("@x-harness/agent-loop").AgentLoopService;
  readonly scripts: Map<string, Array<AsyncGenerator<LlmChunk>>>;
  readonly texts: (session?: string) => string;
  readonly submit: (input: Record<string, unknown>) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  readonly stop: (taskId: string) => Promise<{ ok: boolean; text: string }>;
  readonly dispose: () => Promise<void>;
}

interface FixtureOptions {
  readonly deadlineMs?: number;
  readonly agentsDir?: string;
  readonly sandbox?: boolean;
  readonly persistence?: boolean;
}

async function makeFixture(root: string, options: FixtureOptions = {}): Promise<Fixture> {
  const scripts = new Map<string, Array<AsyncGenerator<LlmChunk>>>();
  const ctx = createContext();
  const plugins: readonly Plugin[] = [
    sessionPlugin,
    toolsPlugin,
    systemPromptPlugin,
    llmPlugin,
    agentLoopPlugin,
    createTaskToolsPlugin(),
    ...(options.sandbox === true ? [createPermissionPlugin({ root, mode: "full" as const }), createSandboxPlugin({ root })] : []),
    ...(options.persistence === true ? [createJsonlSessionPersistence({ root: join(root, "sessions") })] : []),
    createAgentDelegationPlugin({ agentsDirs: options.agentsDir !== undefined ? [options.agentsDir] : [], workspaceRoot: root, worktreeSweep: false }),
    createAgentWorkflowPlugin({ userCommandOnly: false, root: join(root, "workflows"), mainSession: "wf-parent" as SessionId,  ...(options.deadlineMs !== undefined ? { taskDeadlineMs: options.deadlineMs } : {}) }),
  ];
  await loadPlugins(ctx, plugins);
  const loop = ctx.use(agentLoopServiceToken);
  const off = ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: (request: LlmRequest) => scripts.get(request.model)?.shift() ?? neverStream(),
  });
  ctx.effect(off);
  const parent = await loop.create({ session: { id: "wf-parent" as SessionId }, agent: { model: "pm", provider: "fake" } });
  if (!parent.ok) throw new Error(parent.reason);
  const registry = ctx.use(toolRegistry);
  return {
    ctx,
    loop,
    scripts,
    texts: (session = "wf-parent") => ctx.use(sessionStore).get(session as SessionId)?.events()
      .filter((e) => e.type === "user/message" || (e as { type?: string }).type === "agent/message")
      .map((e) => JSON.stringify(e.data)).join("\n") ?? "",
    submit: async (input) => {
      const made = await registry.dispatch({ callId: `t-${String(Math.random()).slice(2, 8)}`, name: "workflow_submit", args: input, signal: new AbortController().signal, session: "wf-parent" as SessionId });
      return made.isError === true ? { ok: false, reason: made.content } : { ok: true, text: made.content };
    },
    stop: async (taskId) => {
      const made = await registry.dispatch({ callId: `s-${String(Math.random()).slice(2, 8)}`, name: "task_stop", args: { task_id: taskId }, signal: new AbortController().signal, session: "wf-parent" as SessionId });
      return { ok: made.isError !== true, text: String(made.content) };
    },
    dispose: async () => {
      await parent.value.dispose();
      await ctx.dispose();
    },
  };
}

async function journalOf(root: string): Promise<string> {
  let raw = "";
  for (const rid of await readdir(join(root, "workflows")).catch(() => [] as string[])) {
    raw += await readFile(join(root, "workflows", rid, "journal.jsonl"), "utf8").catch(() => "");
  }
  return raw;
}

describe("task 级 deadline（TDD 全谱）", () => {
  it("① child 挂起（首 chunk 后永挂）：deadline 到 → failed{task-deadline} + 通知 + journal 落账", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-hang-"));
    const f = await makeFixture(root, { deadlineMs: 1_200 });
    f.scripts.set("pm", [hangingStream()]);
    const sent = await f.submit({ description: "hanging child", prompt: "x", result_schema: { type: "object" } });
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => expect(f.texts()).toContain("workflow-notification"), { timeout: 4_000 });
    expect(f.texts()).toContain("failed");
    expect(await journalOf(root)).toContain("task-deadline");
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  }, 15_000);

  it("② critic 挂起（评审 settlement 永不到达）：deadline 到 → 终局（critic 行尽力归还）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-hang2-"));
    const { mkdir, writeFile } = await import("node:fs/promises");
    const agentsDir = join(root, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "reviewer.md"), "---\nname: reviewer\ndescription: c\nmodel: critic-model\n---\nYou review.");
    const f = await makeFixture(root, { agentsDir, deadlineMs: 1_200 });
    f.scripts.set("pm", [textScript("the deliverable")]);
    f.scripts.set("critic-model", [hangingStream()]);
    const sent = await f.submit({ description: "hanging critic", prompt: "x", critic: { type: "reviewer" } });
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => expect(f.texts()).toContain("workflow-notification"), { timeout: 4_000 });
    expect(f.texts()).toContain("failed");
    expect(await journalOf(root)).toContain("task-deadline");
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  }, 15_000);

  it("③ 快任务对照：宽 deadline 下正常 pass + deliverable（防误伤）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-hang3-"));
    const f = await makeFixture(root, { deadlineMs: 60_000 });
    f.scripts.set("pm", [textScript('{"a":1}')]);
    const sent = await f.submit({ description: "fast task", prompt: "x", result_schema: { type: "object", required: ["a"] } });
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => expect(f.texts()).toContain("finished: passed"), { timeout: 5_000 });
    expect(f.texts()).toContain("deliverable:");
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  }, 15_000);

  it("④ 回炉慢打转（每轮正常但总时长无界）：deadline 先于预算耗尽截断", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-hang4-"));
    const f = await makeFixture(root, { deadlineMs: 1_500 });
    // 每轮 600ms 的无效交付：round1 0.6s → round2 1.2s → round3 进行中 1.5s deadline 触发
    f.scripts.set("pm", Array.from({ length: 5 }, () => textScript("not json", 600)));
    const sent = await f.submit({ description: "slow spin", prompt: "x", result_schema: { type: "object", required: ["a"] } });
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => expect(f.texts()).toContain("workflow-notification"), { timeout: 5_000 });
    expect(f.texts()).toContain("failed");
    const journal = await journalOf(root);
    expect(journal).toContain("task-deadline"); // 时间闸赢
    expect(journal).not.toContain("budget-exhausted"); // 非预算终局
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  }, 15_000);

  it("⑤ 验收命令挂起（命令自身 120s 超时 >> task 窗口）：task deadline 先截断", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-hang5-"));
    const sideEffect = join(root, "side.count");
    const f = await makeFixture(root, { deadlineMs: 1_500, sandbox: true });
    f.scripts.set("pm", [textScript('{"title":"ok"}')]);
    const sent = await f.submit({ description: "verify hang", prompt: "x", result_schema: { type: "object", required: ["title"] }, acceptance: { command: `sleep 60; echo ran >> ${sideEffect}; true` } });
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => expect(f.texts()).toContain("workflow-notification"), { timeout: 5_000 });
    expect(f.texts()).toContain("failed");
    expect(await journalOf(root)).toContain("task-deadline");
    const side = await readFile(sideEffect, "utf8").catch(() => "");
    expect(side).not.toContain("ran"); // 副作用未发生（命令被截断在先）
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  }, 20_000);

  it("⑥ 迟到结算：deadline 终局后挂起子苏醒完成 → 不复活/不二次通知/终局不变（trailing 收编）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-hang6-"));
    const f = await makeFixture(root, { deadlineMs: 1_200 });
    f.scripts.set("pm", [textScript('{"a":1}', 2_500)]); // 苏醒：2.5s 后交合格交付物（deadline 1.2s 已终局）
    const sent = await f.submit({ description: "late wake", prompt: "x", result_schema: { type: "object", required: ["a"] } });
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => expect(f.texts()).toContain("workflow-notification"), { timeout: 4_000 });
    await sleep(2_500); // 跨过苏醒点
    const texts = f.texts();
    expect(texts.match(/workflow-notification/g)?.length ?? 0).toBe(1); // 恰一条通知
    expect(texts).toContain("wall-clock deadline"); // 终局不被迟到合格交付物翻转（cause 词面经 detail 文案）
    const journal = await journalOf(root);
    expect(journal.match(/task\/settled/g)?.length ?? 0).toBe(1); // 恰一次终局
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  }, 20_000);

  it("⑦ 终局后 task_stop 幂等：deadline 收尾后 stop → not-found（生命周期闭合）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-hang7-"));
    const f = await makeFixture(root, { deadlineMs: 1_200 });
    f.scripts.set("pm", [hangingStream()]);
    const sent = await f.submit({ description: "stop after deadline", prompt: "x", result_schema: { type: "object" } });
    expect(sent.ok).toBe(true);
    const taskId = sent.ok ? (sent.text.match(/taskId: (\S+) /)?.[1] ?? "") : "";
    await vi.waitFor(() => expect(f.texts()).toContain("workflow-notification"), { timeout: 4_000 });
    const stopped = await f.stop(taskId);
    expect(stopped.ok).toBe(false);
    expect(stopped.text).toMatch(/not-found/); // run 已结算出表——迟到 miss 前缀纪律
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  }, 15_000);

  it("⑧ dispose 先于 deadline：拆卸后定时器不写盘（journal 稳定——钉子测试）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-hang8-"));
    const f = await makeFixture(root, { deadlineMs: 1_200, persistence: true });
    f.scripts.set("pm", [hangingStream()]);
    const sent = await f.submit({ description: "dispose race", prompt: "x", result_schema: { type: "object" } });
    expect(sent.ok).toBe(true);
    await sleep(300);
    await f.ctx.use(sessionStore).flush("wf-parent" as SessionId).catch(() => {});
    const before = await journalOf(root);
    await f.dispose(); // deadline 之前拆卸
    await sleep(2_000); // 跨过 deadline 时点
    const after = await journalOf(root);
    expect(after).toBe(before); // 拆卸后零写入
    await rm(root, { recursive: true, force: true });
  }, 15_000);

  it("⑩ 恢复路径挂起：崩溃恢复 kick 后子挂 → deadline（attach 时武装）照样终局", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-hang10-"));
    await craftInterruptedTask(root);
    const f = await makeFixture(root, { deadlineMs: 1_500, persistence: true }); // plugin apply 自动扫描恢复
    f.scripts.set("pm", [hangingStream()]); // kick 后挂起
    await vi.waitFor(() => expect(f.texts()).toContain("workflow-notification"), { timeout: 5_000 });
    expect(f.texts()).toContain("failed");
    expect(await journalOf(root)).toContain("task-deadline");
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  }, 20_000);

  it("⑪ rebind 后 deadline 触发：通知落新会话（归属迁移交互）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-hang11-"));
    const f = await makeFixture(root, { deadlineMs: 1_500 });
    f.scripts.set("pm", [hangingStream()]);
    const sent = await f.submit({ description: "rebind then deadline", prompt: "x", result_schema: { type: "object" } });
    expect(sent.ok).toBe(true);
    const second = await f.loop.create({ session: { id: "wf-parent2" as SessionId }, agent: { model: "pm", provider: "fake" } });
    if (!second.ok) throw new Error(second.reason);
    const rebound = await f.ctx.tryUse(workflowView)?.rebind("wf-parent2" as SessionId);
    expect(rebound?.ok).toBe(true);
    await vi.waitFor(() => expect(f.texts("wf-parent2")).toContain("workflow-notification"), { timeout: 5_000 });
    expect(f.texts("wf-parent2")).toContain("wall-clock deadline");
    expect(f.texts("wf-parent")).not.toContain("workflow-notification"); // 旧会话不收
    await second.value.dispose();
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  }, 20_000);
});
