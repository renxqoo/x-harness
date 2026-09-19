// e2e：toolbox 四工具旅程（docs/TOOLBOX.md §8——进默认门）。
// 真实装配 session+jsonl+tools+llm+system-prompt+agent-loop+session-checkpoint+toolbox 四插件
// +task-tools（bashTasks 句柄接线——件14）；脚本化假 LLM 驱动七步工具链：write→read（开门）→
// 覆写（观察门放行）→bash 追加+建文件→未观察覆写拒（fail-closed）→grep 命中→bash 后台立返任务 id。
// 断言盘上副作用、事件落账；后台任务经 task_output/task_stop 收读停（bash 源接线自动探测点）。
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
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
import { createToolbox } from "@x-harness/toolbox";
import { createTaskToolsPlugin } from "@x-harness/task-tools";
import { must } from "./check.ts";

function callScript(callId: string, name: string, args: Record<string, unknown>): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "tool-call-delta", index: 0, callId, name, argumentsDelta: JSON.stringify(args) };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

function textScript(text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

export async function runToolboxJourney(): Promise<void> {
  // grep 是 rg 硬依赖（TOOLBOX.md §5）——缺席 = 环境配置错误，fail-fast 报可行动指引
  must(Bun.which("rg") !== null, "e2e 需要 ripgrep：brew install ripgrep / apt install ripgrep，或设 X_HARNESS_RG_PATH");
  const root = await mkdtemp(join(tmpdir(), "xh-toolbox-e2e-"));
  try {
    const ctx = createContext();
    const env = createLocalEnv(root);
    const box = createToolbox({ root, defaultTimeoutMs: 10_000, env });
    const scripts: Array<AsyncGenerator<LlmChunk>> = [];
    await loadPlugins(ctx, [
      sessionPlugin,
      createJsonlSessionPersistence({ root }),
      toolsPlugin,
      box.readPlugin,
      box.writePlugin,
      box.bashPlugin,
      box.grepPlugin,
      createTaskToolsPlugin({ bashTasks: box.tasks }),
      llmPlugin,
      systemPromptPlugin,
      agentLoopPlugin,
      sessionCheckpointPlugin,
    ]);
    ctx.use(llmRuntime).registerAdapter({
      name: "fake",
      stream: () => scripts.shift() ?? textScript("(exhausted)"),
    });
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
        callScript("tc-3", "write", { path: "notes/journey.txt", content: "intro\nalpha needle v2\nbeta line\n" }), // 同会话 read 过 → 观察门放行
        callScript("tc-4", "bash", { command: "printf 'bash-tail' >> notes/journey.txt; printf 'made-by-bash' > made-by-bash.txt" }),
        callScript("tc-5", "write", { path: "made-by-bash.txt", content: "hijack" }), // bash 产物未观察 → fail-closed
        callScript("tc-6", "grep", { pattern: "needle" }),
        callScript("tc-7", "bash", { command: "sleep 0.3; echo bg-needle-marker", run_in_background: true }), // 后台：立返任务 id
        textScript("toolbox journey done"),
      );
      agent.followup("run the toolbox chain");
      await agent.whenIdle();
      const events = agent.session.events();
      const results = events.filter((e) => e.type === "tool/result");
      must(results.length === 7, `七步工具结果落账（实际：${String(results.length)}）`);
      must(readFileSync(join(root, "notes/journey.txt"), "utf8") === "intro\nalpha needle v2\nbeta line\nbash-tail", "盘上副作用：write 两轮 + bash 追加按序可见");
      must(readFileSync(join(root, "made-by-bash.txt"), "utf8") === "made-by-bash", "观察门 fail-closed：bash 产物未被未观察 write 劫持");
      must(JSON.stringify(results[4]?.data).includes("FS_NOT_OBSERVED"), "tc-5 结果是 FS_NOT_OBSERVED（可行动拒因）");
      must(JSON.stringify(results[5]?.data).includes("needle"), "grep 命中经真实 agent turn（notes/journey.txt:2:alpha needle v2）");
      const bgStarted = JSON.stringify(results[6]?.data);
      must(bgStarted.includes("Background task t-"), "tc-7 立返后台任务 id（不等待完成）");
      const taskId = (bgStarted.match(/t-[0-9a-f]+/) ?? [])[0];
      must(taskId !== undefined, "任务 id 可解析");
      // 模型侧读停经 task_output/task_stop（bash 源接线探测——件14 终态）
      const dispatch = ctx.use(toolRegistry);
      const read = await dispatch.dispatch({ callId: "e2e-tt-1", name: "task_output", args: { task_id: taskId, block: true, timeout: 5_000 }, signal: new AbortController().signal, session: "toolbox" as SessionId });
      must(!read.isError && read.content.includes("completed exit=0"), `task_output 收终态（实际：${read.content}）`);
      must(read.content.includes("bg-needle-marker"), "task_output 带输出切片（bg-needle-marker 到场）");
      const long = await box.tasks.start({ command: "sleep 30", cwd: root, session: "toolbox" as SessionId, env });
      must(long.ok, `长任务起（实际：${long.ok === false ? long.reason : "ok"}）`);
      const stopped = await dispatch.dispatch({ callId: "e2e-tt-2", name: "task_stop", args: { task_id: long.ok ? long.value.id : "" }, signal: new AbortController().signal, session: "toolbox" as SessionId });
      must(!stopped.isError && stopped.content.includes("killed"), `task_stop 两段杀收敛（实际：${stopped.content}）`);
      must(!stopped.content.includes("mid-kill"), "stop 后快照是终态非撕裂");
      must(JSON.stringify(events.at(-1)?.data).includes('"completed"'), "turn completed 收轮");
      await made.value.dispose();
    }
    await ctx.dispose();
    console.log("旅程：read/write/bash/grep + 后台任务 七步经真实 agent turn（观察门 fail-closed + 盘上副作用 + task_output/task_stop 收读停）通过");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
