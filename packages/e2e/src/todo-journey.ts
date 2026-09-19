// e2e：todo 清单旅程（docs/TODO.md §4.B/§6——进默认门）。
// 真实装配 session+jsonl+tools+llm+system-prompt+agent-loop+session-checkpoint+todo-tools；
// 脚本化假 LLM 驱动八步工具链：create×2 → 依赖（addBlockedBy）→ in_progress+owner →
// completed → list（阻塞注记）→ deleted（删除优先回执）→ 删后 not-found 收尾。
// 断言 tool/result 落账数量、铸文锚、todoList 服务终态快照；无 session 直连可见（共享清单锚）。
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

export async function runTodoJourney(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "xh-todo-e2e-"));
  try {
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
    ctx.use(llmRuntime).registerAdapter({
      name: "fake",
      stream: () => scripts.shift() ?? textScript("(exhausted)"),
    });
    const made = await ctx.use(agentLoopServiceToken).create({
      session: { id: "todo" as SessionId },
      agent: { model: "fake-model", provider: "fake" },
    });
    must(made.ok, `agent 创建（实际：${made.ok === false ? made.reason : "ok"}）`);
    if (made.ok) {
      const agent = made.value.agent;
      scripts.push(
        callScript("tc-1", "task_create", { subject: "Ship login fix", activeForm: "Shipping login fix" }),
        callScript("tc-2", "task_create", { subject: "Add regression test" }),
        callScript("tc-3", "task_update", { taskId: "2", addBlockedBy: ["1"] }),
        callScript("tc-4", "task_update", { taskId: "1", status: "in_progress", owner: "main" }),
        callScript("tc-5", "task_update", { taskId: "1", status: "completed" }),
        callScript("tc-6", "task_list", {}),
        callScript("tc-7", "task_update", { taskId: "2", status: "deleted", subject: "ignored-by-delete" }),
        callScript("tc-8", "task_get", { taskId: "2" }),
        textScript("todo journey done"),
      );
      agent.followup("run the todo chain");
      await agent.whenIdle();
      const events = agent.session.events();
      const results = events.filter((e) => e.type === "tool/result");
      must(results.length === 8, `八步工具结果落账（实际：${String(results.length)}）`);
      const textOf = (i: number): string => JSON.stringify(results[i]?.data) ?? "";
      must(textOf(0).includes("Created task 1: Ship login fix (status: pending)"), `tc-1 创建回执（实际：${textOf(0)}）`);
      must(textOf(1).includes("Created task 2"), "tc-2 第二任务 id 递增");
      must(textOf(3).includes("Status: in_progress") && textOf(3).includes("Owner: main"), "tc-4 开工+认领可见");
      const listText = textOf(5);
      must(
        listText.includes("1. [completed] Ship login fix (owner: main; blocks: 2)") && listText.includes("2. [pending] Add regression test (blocked by: 1)"),
        `tc-6 list 行格式与双向阻塞注记（实际：${listText}）`,
      );
      must(textOf(6).includes("Deleted task 2"), "tc-7 删除优先回执（同传 subject 被忽略）");
      must(textOf(7).includes("not-found:2; no such task"), "tc-8 删后 not-found 收尾");
      // 服务终态：清单余 1（completed），依赖边随删除清空
      const store = ctx.use(todoList);
      const final = store.list();
      must(final.length === 1 && final[0]?.status === "completed" && final[0]?.blocks.length === 0, "todoList 服务终态：2 已删、1 完工、无悬空边");
      must(store.get("2").ok === false, "服务面 get 已删 id = not-found");
      // 共享清单锚：无 session 直连可见（与件14 task_output 拒无 session 有意相反——协作载体）
      const anon = await ctx.use(toolRegistry).dispatch({ callId: "e2e-todo-anon", name: "task_list", args: {}, signal: new AbortController().signal });
      must(!anon.isError && anon.content.includes("1. [completed]"), `无 session 直连 task_list（实际：${anon.content}）`);
      const turnEnds = events.filter((e) => e.type === "turn/end");
      must(JSON.stringify(turnEnds.at(-1)?.data).includes('"completed"'), "turn completed 收轮（turn 终态事件断言——不依赖最后一条落账形态）");
      await made.value.dispose();
    }
    await ctx.dispose();
    console.log("旅程：todo 四动词八步经真实 agent turn（铸文锚 + 删除优先 + 删后 not-found + 服务终态 + 共享清单）通过");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
