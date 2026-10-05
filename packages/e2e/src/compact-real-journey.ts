import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import { createAnthropicCompatAdapter, llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmRequest } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import type { Agent } from "@x-harness/agent-loop";
import { compactionLanded, createCompactionPlugin } from "@x-harness/compaction";
import { textScript } from "@x-harness/testkit";

const API_KEY = process.env.GLM_API_KEY;
const BASE_URL = process.env.GLM_BASE_URL;
const FLASH_MODEL = process.env.GLM_FLASH_MODEL ?? "glm-5.3-flash";
const CONTEXT_WINDOW = 6_000;
const TRIGGER_PCT = 85;

function credentialsAbsent(): boolean {
  return (process.env.GLM_API_KEY ?? "") === "" || (process.env.GLM_BASE_URL ?? "") === "";
}

function must(condition: boolean, label: string): void {
  if (!condition) throw new Error(`旅程失败：${label}`);
}

interface CompactWorld {
  readonly ctx: ReturnType<typeof createContext>;
  readonly mainCalls: LlmRequest[];
  readonly summaryCalls: LlmRequest[];
  readonly agent: Agent;
}

async function assembleWorld(root: string, sessionId: string): Promise<CompactWorld> {
  const ctx = createContext();
  const mainCalls: LlmRequest[] = [];
  const summaryCalls: LlmRequest[] = [];
  await loadPlugins(ctx, [
    sessionPlugin,
    createJsonlSessionPersistence({ root }),
    toolsPlugin,
    llmPlugin,
    systemPromptPlugin,
    agentLoopPlugin,
    createCompactionPlugin({
      contextWindow: CONTEXT_WINDOW,
      triggerPct: TRIGGER_PCT,
      reserveTokens: 200,
      keepRecentTokens: 100,
      keepMinTurns: 1,
      summarizer: { model: FLASH_MODEL, provider: "GLM", contextWindow: 200_000, maxOutputTokens: 4_000 },
    }),
  ]);
  ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: (request) => {
      mainCalls.push(request);
      return textScript(`answer about ${String((request.messages.at(-1) as { content?: ReadonlyArray<{ text: string }> } | undefined)?.content?.[0]?.text ?? "topic").slice(0, 20)}`);
    },
  });
  ctx.use(llmRuntime).registerAdapter(
    createAnthropicCompatAdapter({ name: "GLM", baseUrl: BASE_URL as string, apiKey: API_KEY as string, contextWindow: 1_000_000 }),
  );
  const rawStream = ctx.use(llmRuntime).stream.bind(ctx.use(llmRuntime));
  const runtime = ctx.use(llmRuntime);
  (runtime as { stream: (request: LlmRequest) => AsyncIterable<unknown> }).stream = (request) => {
    if (request.provider === "GLM") summaryCalls.push(request);
    return rawStream(request);
  };
  const made = await ctx.use(agentLoopServiceToken).create({
    session: { id: sessionId as SessionId },
    agent: { model: "fake-main", provider: "fake" },
  });
  must(made.ok, `agent 创建成功（实际：${made.ok ? "ok" : made.reason}）`);
  if (!made.ok) throw new Error(made.reason);
  return { ctx, mainCalls, summaryCalls, agent: made.value.agent };
}

export async function runCompactRealJourney(): Promise<void> {
  if (credentialsAbsent()) {
    console.log("skip: compact-real（env 凭证缺席）");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "xh-compact-real-"));
  try {
    const world = await assembleWorld(root, "compact-real-e2e");
    try {
      const landed: string[] = [];
      world.ctx.on(compactionLanded, (payload: { trigger: string }) => landed.push(payload.trigger));
      for (let round = 0; round < 4; round += 1) {
        world.agent.followup(`question-${String(round)} ${"context detail ".repeat(600)}`);
        await world.agent.whenIdle();
      }
      must(landed.length >= 1, `水位压缩真实落账（实际 ${String(landed.length)}）`);
      must(landed.every((t) => t === "auto"), `触发源为 auto（实际 ${landed.join(",")}）`);
      must(world.summaryCalls.length >= 1, "摘要拨号发生");
      for (const call of world.summaryCalls) {
        must(call.model === FLASH_MODEL, `摘要拨号模型 ${FLASH_MODEL}（实际 ${call.model}）`);
        must(call.thinking === "off", `thinking off（实际 ${String(call.thinking)}）`);
      }
      const session = world.agent.session;
      const replaceEvents = session.events().filter((e) => e.type === "user/message" && typeof e.surfaceOp === "object");
      must(replaceEvents.length >= 1, "replace 型 user/message 落 journal");
      const lastCall = world.mainCalls.at(-1);
      must(lastCall !== undefined, "压缩后有主链路拨号");
      const rawConversation = 4 * ("context detail ".repeat(600).length + 200);
      const conversationBody = (lastCall?.messages ?? [])
        .filter((m) => m.role !== "system")
        .map((m) => JSON.stringify(m))
        .join("");
      const projectionText = (lastCall?.messages ?? []).map((m) => JSON.stringify(m)).join("");
      must(projectionText.includes("## Goal"), "真实摘要（七段结构）在投影头部");
      const bulkyBodies = (lastCall?.messages ?? [])
        .filter((m) => m.role === "user" && JSON.stringify(m).includes("context detail".repeat(10)))
        .map((m) => JSON.stringify(m).length);
      must(bulkyBodies.length <= 2, `原文大块仅剩最近 ≤2 轮（实际 ${String(bulkyBodies.length)} 块）`);
      void conversationBody;
      void rawConversation;
      console.log(`compact-real 通过：真实 GLM 摘要 ${String(world.summaryCalls.length)} 次拨号、replace ${String(replaceEvents.length)} 次、对话体投影 ${String(conversationBody.length)} chars`);
    } finally {
      await world.ctx.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
