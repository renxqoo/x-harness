// e2e：todo 清单旅程（docs/TODO.md §13 修订B §4——进默认门）。
// 真实装配 session+jsonl+tools+todo-tools+llm+system-prompt+agent-loop+session-checkpoint；
// 脚本化假 LLM 驱动八步工具链（create×2 → 依赖 → in_progress+owner → completed → list →
// 第二任务开工【存活带依赖到 resume 后】→ get 卡片）；断言 tool/result 落账、todo/snapshot
// 事件 last-wins、匿名桶独立；resume 段（dispose → 新装配同 root → agentLoop.resume →
// followup 触发惰性恢复）断言清单/依赖边/seq 续号跨重启回来。
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
import { createTodoToolsPlugin } from "@x-harness/todo-tools";
import { todoList } from "@x-harness/todo-tools";
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

interface World {
  ctx: ReturnType<typeof createContext>;
  scripts: Array<AsyncGenerator<LlmChunk>>;
}

/** 同 root 装配世界（resume 段「进程重开」复用同形态） */
async function assembleWorld(root: string): Promise<World> {
  const ctx = createContext();
  const scripts: Array<AsyncGenerator<LlmChunk>> = [];
  await loadPlugins(ctx, [
    sessionPlugin,
    createJsonlSessionPersistence({ root }),
    toolsPlugin,
    createTodoToolsPlugin(),
    llmPlugin,
    systemPromptPlugin,
    agentLoopPlugin,
    sessionCheckpointPlugin,
  ]);
  ctx.use(llmRuntime).registerAdapter({ name: "fake", stream: () => scripts.shift() ?? textScript("(exhausted)") });
  return { ctx, scripts };
}

/** 第一进程：八步工具链 + todo/snapshot 落卷断言（任务 2 存活带依赖到 resume 后） */
async function firstLife(root: string): Promise<void> {
  {
    const w1 = await assembleWorld(root);
    const made = await w1.ctx.use(agentLoopServiceToken).create({
      session: { id: "todo" as SessionId },
      agent: { model: "fake-model", provider: "fake" },
    });
    must(made.ok, `agent 创建（实际：${made.ok === false ? made.reason : "ok"}）`);
    if (made.ok) {
      const agent = made.value.agent;
      w1.scripts.push(
        callScript("tc-1", "task_create", { subject: "Ship login fix", activeForm: "Shipping login fix" }),
        callScript("tc-2", "task_create", { subject: "Add regression test" }),
        callScript("tc-3", "task_update", { taskId: "2", addBlockedBy: ["1"] }),
        callScript("tc-4", "task_update", { taskId: "1", status: "in_progress", owner: "main" }),
        callScript("tc-5", "task_update", { taskId: "1", status: "completed" }),
        callScript("tc-6", "task_list", {}),
        callScript("tc-7", "task_update", { taskId: "2", status: "in_progress" }),
        callScript("tc-8", "task_get", { taskId: "2" }),
        textScript("todo journey first life done"),
      );
      agent.followup("run the todo chain");
      await agent.whenIdle();
      const events = agent.session.events();
      const results = events.filter((e) => e.type === "tool/result");
      must(results.length === 8, `八步工具结果落账（实际：${String(results.length)}）`);
      const textOf = (i: number): string => JSON.stringify(results[i]?.data) ?? "";
      must(textOf(0).includes("Created task 1: Ship login fix (status: pending)"), `tc-1 创建回执（实际：${textOf(0)}）`);
      must(textOf(3).includes("Status: in_progress") && textOf(3).includes("Owner: main"), "tc-4 开工+认领可见");
      const listText = textOf(5);
      must(
        listText.includes("1. [completed] Ship login fix (owner: main; blocks: 2)") && listText.includes("2. [pending] Add regression test (blocked by: 1)"),
        `tc-6 list 行格式与双向阻塞注记（实际：${listText}）`,
      );
      must(textOf(7).includes("Task 2: Add regression test") && textOf(7).includes("Blocked by: 1"), "tc-8 卡片带依赖");
      // 持久化证据：todo/snapshot 事件随变更落卷，last-wins == 桶终态
      const snapshots = events.filter((e) => e.type === "todo/snapshot");
      must(snapshots.length === 6, `六次变更各落一条快照（实际：${String(snapshots.length)}）`);
      const last = snapshots.at(-1);
      const lastData = JSON.stringify(last?.data);
      must(lastData.includes('"status":"in_progress"') && lastData.includes('"subject":"Add regression test"'), "卷尾快照 = 桶终态（任务 2 in_progress）");
      // 匿名桶独立（共享清单断言随修订B 反转）：无 session 直连看到空清单
      const anon = await w1.ctx.use(toolRegistry).dispatch({ callId: "e2e-todo-anon", name: "task_list", args: {}, signal: new AbortController().signal });
      must(!anon.isError && anon.content === "No tasks", `匿名桶独立为空（实际：${anon.content}）`);
      // —— 「会话关闭」：dispose 前置 flush（resume 不读截断卷）——
      await made.value.dispose();
    }
    await w1.ctx.dispose();
  }
}

/** 第二进程：同 root 新装配 → resume → 惰性恢复 → 续号断言 */
async function resumedLife(root: string): Promise<void> {
  {
    const w2 = await assembleWorld(root);
    const resumed = await w2.ctx.use(agentLoopServiceToken).resume({ id: "todo" as SessionId, agent: { model: "fake-model", provider: "fake" } });
    must(resumed.ok, `resume 成功（实际：${resumed.ok === false ? resumed.reason : "ok"}）`);
    if (resumed.ok) {
      const agent = resumed.value.agent;
      w2.scripts.push(
        callScript("rc-1", "task_list", {}), // 首触达 = 惰性恢复（单一同步段内 fold）
        callScript("rc-2", "task_create", { subject: "Document fix" }), // seq 恢复证明：id 从 3 续号
        textScript("todo journey resumed"),
      );
      agent.followup("check the list and add one");
      await agent.whenIdle();
      const events2 = agent.session.events();
      // resume 卷 = seed 前缀 + 新事件——按 callId 前缀取本进程新落账
      const results2 = events2.filter((e) => e.type === "tool/result" && String((e.data as { callId?: string }).callId).startsWith("rc-"));
      must(results2.length === 2, `resume 后两步落账（实际：${String(results2.length)}）`);
      const listOut = JSON.stringify(results2[0]?.data) ?? "";
      must(
        listOut.includes("1. [completed] Ship login fix (owner: main; blocks: 2)") && listOut.includes("2. [in_progress] Add regression test (blocked by: 1)"),
        `惰性恢复：清单与依赖边跨重启回来（实际：${listOut}）`,
      );
      must((JSON.stringify(results2[1]?.data) ?? "").includes("Created task 3: Document fix"), `seq 续号——新建 id=3 不撞既有（实际：${JSON.stringify(results2[1]?.data) ?? ""}）`);
      // 服务终态：resume 后清单三任务、id 3 在场（服务面读桶）
      const final = w2.ctx.use(todoList).list("todo" as SessionId);
      must(final.length === 3 && final[2]?.id === "3", `服务终态三任务含续号 id=3（实际：${String(final.map((t) => t.id))}）`);
      // resume 后持久化继续工作：rc-2 变更的新快照已落卷（含续号 id 3）
      const newSnaps = events2.filter((e) => e.type === "todo/snapshot" && JSON.stringify(e.data).includes('"id":"3"'));
      must(newSnaps.length === 1, `resume 后新快照落卷含 id=3（实际：${String(newSnaps.length)}）`);
      const turnEnds = events2.filter((e) => e.type === "turn/end");
      must(JSON.stringify(turnEnds.at(-1)?.data).includes('"completed"'), "turn completed 收轮（turn 终态事件断言——不依赖最后一条落账形态）");
      await resumed.value.dispose();
    }
    await w2.ctx.dispose();
  }
}

export async function runTodoJourney(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "xh-todo-e2e-"));
  try {
    await firstLife(root);
    await resumedLife(root);
    console.log("旅程：todo 四动词八步 + todo/snapshot 落卷 + 匿名桶独立 + resume 惰性恢复（清单/依赖/seq 续号）通过");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
