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

export async function runWorkflowCrashTierAJourney(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "xh-e2e-wf-a-"));
  try {
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
    await sleep(400);
    await first.ctx.use(sessionStore).flush("wf-parent" as SessionId).catch(() => {});
    await parentMade.value.dispose();
    await first.ctx.dispose();
    void registry1;

    const second = await assembleWorld({ root });
    const resumed = await second.loop.resume({ id: "wf-parent" as SessionId, agent: { model: "pm", provider: "fake" } });
    if (!resumed.ok) {
      noteIssue(`旅程A：父会话 resume 失败（${resumed.reason}）`);
      await second.ctx.dispose();
      return;
    }
    second.scripts.set("pm", []);
    await sleep(600);
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
    issues.length = 0;
  }
}

export async function runWorkflowCrashTierBJourney(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "xh-e2e-wf-b-"));
  const sideEffect = join(root, "side-effect.count");
  try {
    const first = await assembleWorld({ root });
    const parentMade = await first.loop.create({ session: { id: "wf-parent" as SessionId }, agent: { model: "pm", provider: "fake" } });
    if (!parentMade.ok) throw new Error(`parent 创建失败：${parentMade.reason}`);
    first.scripts.set("pm", [textScript('{"title":"for command tier"}')]);
    const registry1 = first.ctx.use((await import("@x-harness/tools")).toolRegistry);
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
    await sleep(700);
    await first.ctx.use(sessionStore).flush("wf-parent" as SessionId).catch(() => {});
    await parentMade.value.dispose();
    await first.ctx.dispose();

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
    await sleep(1_500);
    await first.ctx.use(sessionStore).flush("wf-parent" as SessionId).catch(() => {});
    await parentMade.value.dispose();
    await first.ctx.dispose();

    const second = await assembleWorld({ root, agentsDir });
    const resumed = await second.loop.resume({ id: "wf-parent" as SessionId }, );
    if (!resumed.ok) {
      noteIssue(`旅程C：父会话 resume 失败（${resumed.reason}）`);
      await second.ctx.dispose();
      return;
    }
    second.scripts.set("pm", [textScript("irrelevant")]);
    second.scripts.set("critic-model", [textScript('{"verdict":"pass"}')]);
    await sleep(800);
    const notified = await waitFor(async () => (await parentTexts(second)).includes("workflow-notification"), "旅程C：恢复后终局通知", 12_000);
    if (notified) {
      const texts = await parentTexts(second);
      if (!texts.includes("finished: passed")) noteIssue(`旅程C：终局非 passed（critic 二世 pass 应过——实际通知见 journal）`);
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

export async function runWorkflowCrashJourneys(): Promise<readonly string[]> {
  await runWorkflowCrashTierAJourney();
  await runWorkflowCrashTierBJourney();
  await runWorkflowCrashTierCJourney();
  return workflowJourneyIssues;
}
