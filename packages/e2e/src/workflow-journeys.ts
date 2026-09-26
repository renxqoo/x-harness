// e2e：件16 workflow 崩溃旅程（§11 承诺——三档各一条含崩溃窗口）。
// 形态：同进程双 world（全灭→重装配档案），对齐 delegation-journeys 的 revive 形态——
// kill -9 的等价语义（ctx.dispose 后 journal/子会话卷全在盘，新装配扫回）。
// 发现的异常如实收集为 exports.issues，供收口统计——不在本文件内静默修补。

import { textScript } from "@x-harness/testkit";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Plugin } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { createAgentDelegationPlugin } from "@x-harness/agent-delegation";
import { createTaskToolsPlugin } from "@x-harness/task-tools";
import { createAgentWorkflowPlugin } from "@x-harness/agent-workflow";
import { must } from "./check.ts";

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
  setTimeout(() => { resolve(); }, ms);
});

/** 崩溃旅程发现的异常（如实收集——收口统计输入） */
export const workflowJourneyIssues: readonly string[] = [];
const issues: string[] = [];
function noteIssue(text: string): void {
  issues.push(text);
}

interface World {
  readonly ctx: ReturnType<typeof createContext>;
  readonly loop: import("@x-harness/agent-loop").AgentLoopService;
  readonly scripts: Map<string, Array<AsyncGenerator<LlmChunk>>>;
  readonly root: string;
}

async function assembleWorld(input: { readonly root: string; readonly agentsDir?: string }): Promise<World> {
  const ctx = createContext();
  const scripts = new Map<string, Array<AsyncGenerator<LlmChunk>>>();
  const plugins: readonly Plugin[] = [
    sessionPlugin,
    toolsPlugin,
    llmPlugin,
    systemPromptPlugin,
    agentLoopPlugin,
    createTaskToolsPlugin(),
    createJsonlSessionPersistence({ root: join(input.root, "sessions") }),
    createAgentDelegationPlugin({ agentsDirs: input.agentsDir !== undefined ? [input.agentsDir] : [], workspaceRoot: input.root, worktreeSweep: false }),
    createAgentWorkflowPlugin({ root: join(input.root, "workflows"), mainSession: "wf-parent" as SessionId }),
  ];
  await loadPlugins(ctx, plugins);
  const loop = ctx.use(agentLoopServiceToken);
  ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: (request: LlmRequest) => scripts.get(request.model)?.shift() ?? (async function* (): AsyncGenerator<LlmChunk> {
      yield { type: "finish", finish: { kind: "stop" } } as never;
    })(),
  });
  return { ctx, loop, scripts, root: input.root };
}

async function parentTexts(world: World): Promise<string> {
  const store = world.ctx.use(sessionStore);
  return store.get("wf-parent" as SessionId)?.events()
    .filter((e) => e.type === "agent/message" || e.type === "user/message")
    .map((e) => JSON.stringify(e.data)).join("\n") ?? "";
}

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 8_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(150);
  }
  noteIssue(`等待超时：${what}`);
  return false;
}

async function readJournalTask(root: string): Promise<{ readonly raw: string; readonly types: readonly string[] }> {
  const { readdir, readFile } = await import("node:fs/promises");
  const wfRoot = join(root, "workflows");
  const runs = await readdir(wfRoot).catch(() => [] as string[]);
  let raw = "";
  for (const rid of runs) raw += await readFile(join(wfRoot, rid, "journal.jsonl"), "utf8").catch(() => "");
  const types = raw.split("\n").filter((l) => l !== "").map((l) => {
    try {
      return (JSON.parse(l) as { type: string }).type;
    } catch {
      return "?corrupt?";
    }
  });
  return { raw, types };
}

/**
 * 旅程 A（Tier A schema + 崩溃在子代理完成后、验收前）：
 * 提交 → 子完成 → **全灭** → 重装配 → 恢复应直接进验收（不重跑）→ 终局 completed + 通知 + deliverable。
 */
export async function runWorkflowCrashTierAJourney(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "xh-e2e-wf-a-"));
  try {
    // 第一世：提交受管任务（schema 档）
    const first = await assembleWorld({ root });
    const parentMade = await first.loop.create({ session: { id: "wf-parent" as SessionId }, agent: { model: "pm", provider: "fake" } });
    if (!parentMade.ok) throw new Error(`parent 创建失败：${parentMade.reason}`);
    first.scripts.set("pm", [textScript('{"title":"crash window deliverable"}')]);
    const registry1 = first.ctx.use(toolsPlugin ? (await import("@x-harness/tools")).toolRegistry : (await import("@x-harness/tools")).toolRegistry);
    const submitted = await registry1.dispatch({
      callId: "wf-a1",
      name: "workflow_submit",
      args: { description: "crash before acceptance", prompt: "produce", result_schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } } },
      signal: new AbortController().signal,
      session: "wf-parent" as SessionId,
    });
    must(!submitted.isError, `受管提交（实际：${submitted.content}）`);
    // 等子完成（通知未到父——受管路径 sink 驱动）——趁验收/结算前全灭
    await sleep(400);
    await first.ctx.use(sessionStore).flush("wf-parent" as SessionId).catch(() => {});
    await parentMade.value.dispose();
    await first.ctx.dispose(); // 全灭（等价 kill -9：journal/子会话卷在盘，内存全失）
    void registry1;

    // 第二世：重装配（同 root）→ plugin apply 扫描恢复
    const second = await assembleWorld({ root });
    const resumed = await second.loop.resume({ id: "wf-parent" as SessionId, agent: { model: "pm", provider: "fake" } });
    if (!resumed.ok) {
      noteIssue(`旅程A：父会话 resume 失败（${resumed.reason}）`);
      await second.ctx.dispose();
      return;
    }
    second.scripts.set("pm", []); // 不再有子脚本——恢复不应重跑子代理（dispatched×completed 窗口直接进验收）
    await sleep(600); // 恢复 + 验收 + 结算 + 通知
    const texts = await parentTexts(second);
    const notified = await waitFor(async () => (await parentTexts(second)).includes("workflow-notification"), "旅程A：恢复后完成通知");
    if (notified) {
      if (!texts.includes("finished: passed")) noteIssue("旅程A：终局非 passed（schema 应过）");
      if (!texts.includes("deliverable:")) noteIssue("旅程A：通知未回传 deliverable（B-9 回归面）");
    }
    const journal = await readJournalTask(root);
    if (!journal.raw.includes("notify/delivered")) noteIssue("旅程A：journal 无 notify/delivered");
    if (!journal.raw.includes("task/settled")) noteIssue("旅程A：journal 无 task/settled（恢复未推进终局）");
    if (journal.types.filter((t) => t === "task/dispatched").length > 1) noteIssue("旅程A：dispatched 多次落账（子代理被重跑——应为直接进验收）");
    await resumed.value.dispose();
    await second.ctx.dispose();
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    issues.length = 0; // 旅程 A 专用清空（issues 已在 finally 前被消费）
  }
}

/**
 * 旅程 B（Tier B command + 崩溃在验收命令执行中）：
 * 提交（schema+command）→ 子完成 → 验收命令在飞（长 sleep）→ **全灭** → 重装配 →
 * 恢复应 verify/started 无 result → unknown 封口 + fail 终局（不重跑命令——副作用防线）。
 */
export async function runWorkflowCrashTierBJourney(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "xh-e2e-wf-b-"));
  const sideEffect = join(root, "side-effect.count");
  try {
    const first = await assembleWorld({ root });
    const parentMade = await first.loop.create({ session: { id: "wf-parent" as SessionId }, agent: { model: "pm", provider: "fake" } });
    if (!parentMade.ok) throw new Error(`parent 创建失败：${parentMade.reason}`);
    first.scripts.set("pm", [textScript('{"title":"for command tier"}')]);
    const registry1 = first.ctx.use((await import("@x-harness/tools")).toolRegistry);
    // 命令带副作用计数：执行一次追加一行（崩溃旅程判定重跑的探针）
    const submitted = await registry1.dispatch({
      callId: "wf-b1",
      name: "workflow_submit",
      args: {
        description: "crash in verify",
        prompt: "produce",
        result_schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
        acceptance: { command: `sleep 5; echo ran >> ${sideEffect}; true` },
      },
      signal: new AbortController().signal,
      session: "wf-parent" as SessionId,
    });
    must(!submitted.isError, `受管提交（实际：${submitted.content}）`);
    await sleep(700); // 子完成 + schema 过 + verify/started 落账 + 命令在飞（sleep 5 未完）
    await first.ctx.use(sessionStore).flush("wf-parent" as SessionId).catch(() => {});
    await parentMade.value.dispose();
    await first.ctx.dispose(); // 全灭在命令执行中

    // 第二世：恢复 → verifying 态 → unknown 封口 + fail（不重跑——side-effect.count 应恰 0 行：
    // 命令没跑完就被杀，恢复不重试）
    const second = await assembleWorld({ root });
    const resumed = await second.loop.resume({ id: "wf-parent" as SessionId, agent: { model: "pm", provider: "fake" } });
    if (!resumed.ok) {
      noteIssue(`旅程B：父会话 resume 失败（${resumed.reason}）`);
      await second.ctx.dispose();
      return;
    }
    second.scripts.set("pm", []);
    await sleep(600);
    const notified = await waitFor(async () => (await parentTexts(second)).includes("workflow-notification"), "旅程B：恢复后终局通知");
    if (notified) {
      const texts = await parentTexts(second);
      if (!texts.includes("failed")) noteIssue("旅程B：终局非 failed（verify 中断应 unknown→fail）");
    }
    const journal = await readJournalTask(root);
    if (!journal.raw.includes("verify-unknown") && !journal.raw.includes("verify/started")) noteIssue("旅程B：journal 无 verify 事件（命令档未接线或时序偏移）");
    const { readFile } = await import("node:fs/promises");
    const sideEffectContent = await readFile(sideEffect, "utf8").catch(() => "");
    const runs = sideEffectContent.split("\n").filter((l) => l === "ran").length;
    if (runs > 0) noteIssue(`旅程B：副作用命令被重跑（ran 计数 ${String(runs)}——应为 0，B-10 副作用双跑防线）`);
    await resumed.value.dispose();
    await second.ctx.dispose();
  } finally {
    for (const issue of issues) (workflowJourneyIssues as unknown as { push: (s: string) => void }).push(issue);
    issues.length = 0;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 旅程 C（Tier C critic + 崩溃在 critic 评审后、提案解析前）：
 * 提交（critic 档，reviewer .md 类型）→ 子完成 → critic 完成产出 fail 提案 → **全灭**（提案
 * 未消费）→ 重装配 → 恢复直接进验收链 → critic 重派（只读评审，重跑无害）→ 终局。
 */
export async function runWorkflowCrashTierCJourney(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "xh-e2e-wf-c-"));
  const agentsDir = join(root, "agents");
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "reviewer.md"), "---\nname: reviewer\ndescription: e2e critic\nmodel: critic-model\n---\nYou review.");
    const first = await assembleWorld({ root, agentsDir });
    const parentMade = await first.loop.create({ session: { id: "wf-parent" as SessionId }, agent: { model: "pm", provider: "fake" } });
    if (!parentMade.ok) throw new Error(`parent 创建失败：${parentMade.reason}`);
    // 崩溃窗口对准「critic 评审在飞」：critic 脚本 2s 延迟 + 全灭在 1.5s（装置教训：
    // 无延迟时整个 fail→reopen→修复→critic#2 链在 900ms 内跑完，崩溃窗根本没命中——
    // 曾因此把装置脚本不足误判为实现缺陷）
    first.scripts.set("pm", [textScript("the deliverable text")]);
    first.scripts.set("critic-model", [(async function* (): AsyncGenerator<LlmChunk> {
      await sleep(2_000);
      yield { type: "text-delta", text: '{"verdict":"fail","reopenProposals":["needs more detail"]}' } as never;
      yield { type: "finish", finish: { kind: "stop" } } as never;
    })()]);
    const registry1 = first.ctx.use((await import("@x-harness/tools")).toolRegistry);
    const submitted = await registry1.dispatch({
      callId: "wf-c1",
      name: "workflow_submit",
      args: { description: "crash after critic", prompt: "produce", critic: { type: "reviewer" } },
      signal: new AbortController().signal,
      session: "wf-parent" as SessionId,
    });
    must(!submitted.isError, `受管提交（实际：${submitted.content}）`);
    await sleep(1_500); // 子完成 + critic 派发在飞（2s 延迟未完）——崩溃窗命中
    await first.ctx.use(sessionStore).flush("wf-parent" as SessionId).catch(() => {});
    await parentMade.value.dispose();
    await first.ctx.dispose();

    // 第二世：恢复 → dispatched×completed → 直接进验收 → critic 重派（本世 pass——
    // 只读评审重跑无害；deliverable 是第一世交付物原文）
    const second = await assembleWorld({ root, agentsDir });
    const resumed = await second.loop.resume({ id: "wf-parent" as SessionId }, );
    if (!resumed.ok) {
      noteIssue(`旅程C：父会话 resume 失败（${resumed.reason}）`);
      await second.ctx.dispose();
      return;
    }
    second.scripts.set("pm", [textScript("irrelevant")]); // 不应被消费（恢复不重跑任务子代理）
    second.scripts.set("critic-model", [textScript('{"verdict":"pass"}')]);
    await sleep(800);
    const notified = await waitFor(async () => (await parentTexts(second)).includes("workflow-notification"), "旅程C：恢复后终局通知", 12_000);
    if (notified) {
      const texts = await parentTexts(second);
      if (!texts.includes("finished: passed")) noteIssue(`旅程C：终局非 passed（critic 二世 pass 应过——实际通知见 journal）`);
      // 恢复不应重跑任务子代理（第一世修复轮的交付物即验收对象）
      if (!texts.includes("deliverable:")) noteIssue("旅程C：通知未回传 deliverable");
    }
    const journal = await readJournalTask(root);
    if (!journal.raw.includes("task/settled")) noteIssue("旅程C：journal 无终局（恢复链断）");
    await resumed.value.dispose();
    await second.ctx.dispose();
  } finally {
    for (const issue of issues) (workflowJourneyIssues as unknown as { push: (s: string) => void }).push(issue);
    issues.length = 0;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/** 旅程注册面（main.ts 挂接）：三档崩溃旅程 + issues 收集口 */
export async function runWorkflowCrashJourneys(): Promise<readonly string[]> {
  await runWorkflowCrashTierAJourney();
  await runWorkflowCrashTierBJourney();
  await runWorkflowCrashTierCJourney();
  return workflowJourneyIssues;
}
