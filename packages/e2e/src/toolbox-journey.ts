import { scriptedAdapter, textScript } from "@x-harness/testkit";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { RG_TARGETS, targetKeyOf } from "../../../scripts/fetch-rg.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { sessionCheckpointPlugin } from "@x-harness/session-checkpoint";
import { createLocalEnv } from "@x-harness/exec-env";
import { PathGate, ObservedRegistry } from "@x-harness/tool-core";
import { createReadPlugin } from "@x-harness/tool-read";
import { createWritePlugin } from "@x-harness/tool-write";
import { backgroundTasks, createBashPlugin, defaultLimits } from "@x-harness/tool-bash";
import { createGrepPlugin } from "@x-harness/tool-grep";
import { createTaskToolsPlugin } from "@x-harness/task-tools";
import { must } from "./check.ts";

function callScript(callId: string, name: string, args: Record<string, unknown>): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "tool-call-delta", index: 0, callId, name, argumentsDelta: JSON.stringify(args) };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

async function waitUntil(probe: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (probe()) return;
    if (Date.now() > deadline) must(false, what);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

function resolveJourneyRgBinDir(): string | undefined {
  const stagedRg = join(import.meta.dirname, "../../../apps/host-hub/dist/bin");
  const staged = readStagedPlatform(stagedRg);
  if (staged !== undefined && existsSync(join(stagedRg, "rg"))) {
    const local = targetKeyOf(process.platform, process.arch);
    if (local !== null && staged === local) return stagedRg;
    process.stderr.write(`e2e: staged rg platform ${staged} ≠ local ${local}（交叉 fetch 残留？）——落 PATH\n`);
  }
  must(Bun.which("rg") !== null, "e2e 需要 ripgrep：bun run fetch:rg（内置 staging），或 brew install ripgrep / apt install ripgrep，或设 X_HARNESS_RG_PATH");
  return undefined;
}

function readStagedPlatform(stagedRg: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(stagedRg, "rg.json"), "utf8")) as { readonly target?: string };
    const target = manifest.target;
    if (typeof target !== "string") return undefined;
    const hit = Object.entries(RG_TARGETS).find(([, t]) => t.triple === target);
    return hit === undefined ? undefined : hit[0];
  } catch {
    return undefined;
  }
}

export async function runToolboxJourney(): Promise<void> {
  const rgBinDir = resolveJourneyRgBinDir();
  const root = await mkdtemp(join(tmpdir(), "xh-toolbox-e2e-"));
  const logRoot = await mkdtemp(join(tmpdir(), "xh-toolbox-logs-"));
  try {
    const ctx = createContext();
    const env = createLocalEnv(root);
    const gate = new PathGate(root);
    const observed = new ObservedRegistry();
    const limits = defaultLimits({ defaultTimeoutMs: 10_000 });
    const scripts: Array<AsyncGenerator<LlmChunk>> = [];
    await loadPlugins(ctx, [
      sessionPlugin,
      createJsonlSessionPersistence({ root }),
      systemPromptPlugin,
      toolsPlugin,
      createReadPlugin({ gate, observed, env, systemRoots: [logRoot] }),
      createWritePlugin({ gate, observed, env }),
      createBashPlugin({ gate, env, limits, taskLimits: { taskLogDir: logRoot } }),
      createGrepPlugin({ gate, env, systemRoots: [logRoot], rgBinDir }),
      createTaskToolsPlugin(),
      llmPlugin,
      agentLoopPlugin,
      sessionCheckpointPlugin,
    ]);
    ctx.use(llmRuntime).registerAdapter(scriptedAdapter({ scripts, exhausted: "(exhausted)" }));
    const made = await ctx.use(agentLoopServiceToken).create({
      session: { id: "toolbox" as SessionId },
      agent: { model: "fake-model", provider: "fake" },
    });
    must(made.ok, `agent 创建（实际：${made.ok === false ? made.reason : "ok"}）`);
    if (made.ok) {
      const agent = made.value.agent;
      scripts.push(
        callScript("tc-1", "write", { path: "notes/journey.txt", content: "intro\nalpha needle\nbeta line\n" }),
        callScript("tc-2", "read", { path: "notes/journey.txt" }),
        callScript("tc-3", "write", { path: "notes/journey.txt", content: "intro\nalpha needle v2\nbeta line\n" }),
        callScript("tc-4", "bash", { command: "printf 'bash-tail' >> notes/journey.txt; printf 'made-by-bash' > made-by-bash.txt" }),
        callScript("tc-5", "write", { path: "made-by-bash.txt", content: "hijack" }),
        callScript("tc-6", "grep", { pattern: "needle" }),
        callScript("tc-7", "bash", { command: "sleep 0.3; echo bg-needle-marker", run_in_background: true }),
        textScript("toolbox journey done"),
        textScript("noted the task notification"),
      );
      agent.followup("run the toolbox chain");
      await agent.whenIdle();
      const results = (): ReturnType<typeof agent.session.events> => agent.session.events().filter((e) => e.type === "tool/result");
      must(results().length === 7, `七步工具结果落账（实际：${String(results().length)}）`);
      must(readFileSync(join(root, "notes/journey.txt"), "utf8") === "intro\nalpha needle v2\nbeta line\nbash-tail", "盘上副作用：write 两轮 + bash 追加按序可见");
      must(readFileSync(join(root, "made-by-bash.txt"), "utf8") === "made-by-bash", "观察门 fail-closed：bash 产物未被未观察 write 劫持");
      must(JSON.stringify(results()[4]?.data).includes("FS_NOT_OBSERVED"), "tc-5 结果是 FS_NOT_OBSERVED（可行动拒因）");
      must(JSON.stringify(results()[5]?.data).includes("needle"), "grep 命中经真实 agent turn（notes/journey.txt:2:alpha needle v2）");
      const bgStarted = JSON.stringify(results()[6]?.data);
      must(bgStarted.includes("Background task t-"), "tc-7 立返后台任务 id（不等待完成）");
      must(bgStarted.includes("output appends to"), "tc-7 返回携带日志路径（读面指针）");
      const logPath = (bgStarted.match(/output appends to ([^"\\;]+);/) ?? [])[1];
      must(logPath !== undefined && logPath.startsWith(logRoot), `日志路径在 taskLogDir 下（实际：${String(logPath)}）`);
      const noticeFrame = (): string | undefined => {
        for (const e of agent.session.events()) {
          if (e.type !== "agent/message") continue;
          const text = JSON.stringify(e.data);
          if (text.includes("bash-task")) return text;
        }
        return undefined;
      };
      await waitUntil(() => noticeFrame() !== undefined, 5_000, "[task-notification] 未落 WAL（通知臂/唤醒链失败）");
      const notice = noticeFrame() ?? "";
      must(notice.includes("[task-notification]"), "通知首行词面");
      must(notice.includes("completed exit=0"), "通知带终态");
      must(notice.includes("bg-needle-marker"), "通知尾部切片带输出证据");
      await agent.whenIdle();
      const dispatch = ctx.use(toolRegistry);
      const readLog = await dispatch.dispatch({ callId: "e2e-log-1", name: "read", args: { path: logPath }, signal: new AbortController().signal, session: "toolbox" as SessionId });
      must(!readLog.isError && readLog.content.includes("bg-needle-marker"), `read 放行日志文件且 marker 到场（实际：${readLog.content.slice(0, 120)}）`);
      const long = await ctx.use(backgroundTasks).start({ command: "sleep 30", cwd: root, session: "toolbox" as SessionId, env });
      must(long.ok, `长任务起（实际：${long.ok === false ? long.reason : "ok"}）`);
      const stopped = await dispatch.dispatch({ callId: "e2e-tt-2", name: "task_stop", args: { task_id: long.ok ? long.value.id : "" }, signal: new AbortController().signal, session: "toolbox" as SessionId });
      must(!stopped.isError && stopped.content.includes("killed"), `task_stop 两段杀收敛（实际：${stopped.content}）`);
      must(!stopped.content.includes("mid-kill"), "stop 后快照是终态非撕裂");
      must(JSON.stringify(agent.session.events().at(-1)?.data).includes('"completed"'), "turn completed 收轮");
      await made.value.dispose();
    }
    await ctx.dispose();
    console.log("旅程：read/write/bash/grep + 后台任务 七步经真实 agent turn（观察门 fail-closed + 盘上副作用 + 日志读面/systemRoots + [task-notification] 推送 + task_stop 收敛）通过");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await rm(logRoot, { recursive: true, force: true }).catch(() => {});
  }
}
