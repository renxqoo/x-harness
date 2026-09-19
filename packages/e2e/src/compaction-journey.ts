// e2e：压缩防线全链旅程（docs/COMPACTION.md §7 e2e 节，进默认门）。
// 真实装配 session+jsonl+tools+llm+system-prompt+agent-loop+compaction+autocompact；
// 脚本化假 LLM 适配器。旅程A：长对话灌入 → 水位压缩落账 → 后续请求用压缩投影。
// 旅程B：假窗口 413 → 紧急自愈重试 + servedWindow 落账 → 任务不中断。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import type { Agent } from "@x-harness/agent-loop";
import { compactionLanded, createCompactionPlugin } from "@x-harness/compaction";
import { createTodoToolsPlugin } from "@x-harness/todo-tools";
import { autocompactL1Cleared, createAutoCompactPlugin } from "@x-harness/autocompact";
import { must } from "./check.ts";

function textScript(text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

function callScript(callId: string, name: string, args: Record<string, unknown>): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "tool-call-delta", index: 0, callId, name, argumentsDelta: JSON.stringify(args) };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

/** 摘要拨号脚本：结构化检查点摘要形态（水位触发时由 compaction 摘要面消费） */
function summaryScript(): AsyncGenerator<LlmChunk> {
  return textScript("## Goal\ndeliver the feature\n\n## Progress\n### In Progress\n- [ ] long task underway");
}

interface AgentWorld {
  readonly ctx: Context;
  readonly calls: LlmRequest[];
  readonly scripts: Array<AsyncGenerator<LlmChunk>>;
  readonly agent: Agent;
}

async function assembleWorld(root: string, options?: { readonly mainDialFails413?: boolean; readonly sessionId?: string }): Promise<AgentWorld> {
  const ctx = createContext();
  const calls: LlmRequest[] = [];
  const scripts: Array<AsyncGenerator<LlmChunk>> = [];
  await loadPlugins(ctx, [
    sessionPlugin,
    createJsonlSessionPersistence({ root }),
    toolsPlugin,
    llmPlugin,
    systemPromptPlugin,
    agentLoopPlugin,
    createTodoToolsPlugin(), // 摘要注入段停靠（docs/COMPACTION.md §15）
    createCompactionPlugin({
      contextWindow: 1_200,
      reserveTokens: 100,
      keepRecentTokens: 2,
      summarizer: { model: "fake-model", provider: "fake", contextWindow: 100_000, maxOutputTokens: 200 },
    }),
    createAutoCompactPlugin({
      contextWindow: 1_200,
      checkpointPct: 60,
      warnBufferTokens: 100,
      compactBufferTokens: 100,
      ledgerBudgetTokens: 200,
      checkpointMinSegmentTokens: 1,
      clearableTools: ["read"],
      checkpointIdleTimeoutMs: 5_000,
    }),
  ]);
  ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: (request) => {
      calls.push(request);
      // 摘要/CP 旁路拨号按提示词特征路由（<conversation> 包裹）；主对话拨号走脚本池
      const isSummaryDial = request.messages.some((message) => {
        if (message.role !== "user" || !("content" in message)) return false;
        const block = message.content[0];
        return block !== undefined && block.type === "text" && block.text.includes("<conversation>");
      });
      if (isSummaryDial) return summaryScript();
      if (options?.mainDialFails413 === true) {
        return (async function* (): AsyncGenerator<LlmChunk> {
          yield { type: "finish", finish: { kind: "error", message: "payload too large", code: "http-413" } };
        })();
      }
      const next = scripts.shift();
      return next ?? textScript("(no script)");
    },
  });
  const made = await ctx.use(agentLoopServiceToken).create({
    session: { id: (options?.sessionId ?? "compaction-e2e") as SessionId },
    agent: { model: "fake-model", provider: "fake" },
  });
  must(made.ok, `agent 创建成功（实际：${made.ok ? "ok" : made.reason}）`);
  if (!made.ok) throw new Error(made.reason);
  return { ctx, calls, scripts, agent: made.value.agent };
}

export async function runCompactionJourney(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "xh-compaction-e2e-"));
  try {
    // —— 旅程 A：长对话灌入 → 水位压缩 → 后续请求投影已缩 ——
    {
      const world = await assembleWorld(root);
      try {
        const landed: string[] = [];
        world.ctx.on(compactionLanded, (payload: { trigger: string }) => landed.push(payload.trigger));
        for (let round = 0; round < 6; round += 1) {
          if (round === 1) {
            // todo 段（§15）：经真实 agent turn 建任务——todo/snapshot 落卷，注入段随后携带
            world.scripts.push(callScript(`tc-e2e-${String(round)}`, "task_create", { subject: "Compaction e2e task" }));
          } else if (round === 3) {
            world.scripts.push(callScript(`tc-e2e-${String(round)}`, "task_update", { taskId: "1", status: "completed" }));
          } else {
            world.scripts.push(textScript(`answer-round-${String(round)} ${"x".repeat(2_400)}`));
          }
          world.agent.followup(`question-${String(round)} ${"q".repeat(2_400)}`);
          await world.agent.whenIdle();
        }
        must(landed.length >= 1, `水位压缩至少落账一次（实际 ${String(landed.length)}）`);
        const lastCall = world.calls.at(-1);
        if (lastCall === undefined) throw new Error("末次拨号缺席");
        const lastMessages = lastCall.messages;
        const hasSummary = lastMessages.some((message) => {
          if (message.role !== "user" || !("content" in message)) return false;
          const block = message.content[0];
          return block !== undefined && block.type === "text" && block.text.includes("## Goal");
        });
        must(hasSummary, "后续请求投影含压缩摘要");
        // §15 注入段：任务行机制性存活过压缩（且为最新态——completed 覆盖 in_progress）
        const hasTaskSection = lastMessages.some((message) => {
          if (message.role !== "user" || !("content" in message)) return false;
          const block = message.content[0];
          return block !== undefined && block.type === "text" && block.text.includes("## Task List");
        });
        must(hasTaskSection, "压缩后投影含 todo 注入段（机制性存活——非摘要 LLM 概率性）");
        const taskLine = lastMessages.map((m) => ("content" in m ? JSON.stringify(m.content) : "")).join("");
        must(taskLine.includes("1. [completed] Compaction e2e task"), "注入段任务行为最新态（completed）");
        must(!taskLine.includes("[in_progress] Compaction e2e task"), "注入段无旧状态残片（in_progress 不得残留——锚点失效防线）");
        const totalChars = lastMessages.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
        must(totalChars < 6 * 5_000, `投影已折叠（实际 ${String(totalChars)} chars）`);
      } finally {
        await world.ctx.dispose();
      }
      console.log("旅程A：长对话 → 水位压缩 → 后续请求投影已缩 通过");
    }

    // —— 旅程 B：假窗口 413 → 紧急自愈重试 + servedWindow 落账 → 任务不中断 ——
    {
      const world = await assembleWorld(root, { mainDialFails413: true, sessionId: "compaction-e2e-413" });
      try {
        const cleared: string[] = [];
        world.ctx.on(autocompactL1Cleared, (payload: { trigger: string }) => cleared.push(payload.trigger));
        world.scripts.push(textScript("warm"));
        world.agent.followup("warm-up");
        await world.agent.whenIdle();
        // 主拨号恒 413：紧急压缩 → 重试仍 413 → heal 键命中 → 放行 fatal → turn 收束
        world.agent.followup("burst");
        await world.agent.whenIdle();
        const outcome = world.agent.session.events().at(-1);
        must(outcome !== undefined && outcome.type === "turn/end", "413 轮以 turn/end 收束（不悬挂）");
        const contextEvents = world.agent.session.events().filter((event) => event.type === "request/context");
        must(contextEvents.some((event) => event.data.contextWindow !== undefined), "servedWindow 落 request/context");
        const replaceEvents = world.agent.session.events().filter((event) => event.type === "user/message" && typeof event.surfaceOp === "object");
        must(replaceEvents.length >= 1, "紧急压缩前缀替换落账");
        void cleared;
      } finally {
        await world.ctx.dispose();
      }
      console.log("旅程B：假窗口 413 → 自愈重试 + servedWindow 落账 → 任务不中断 通过");
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
