// e2e:real——真凭证单 turn 冒烟（docs/SESSION-CHECKPOINT.md §3，P12：opt-in）。
// env X_HARNESS_E2E_REAL_API_KEY + X_HARNESS_E2E_REAL_BASE_URL + X_HARNESS_E2E_REAL_MODEL 齐备才执行；
// 缺席 = 显式 skip（打印计数，退出码 0——缺席不是失败）。不进默认门。
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import { createOpenaiCompatAdapter, llmPlugin, llmRuntime } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { sessionCheckpointPlugin } from "@x-harness/session-checkpoint";
import { must } from "./check.ts";

const API_KEY = process.env.X_HARNESS_E2E_REAL_API_KEY;
const BASE_URL = process.env.X_HARNESS_E2E_REAL_BASE_URL;
const MODEL = process.env.X_HARNESS_E2E_REAL_MODEL;

if (API_KEY === undefined || API_KEY === "" || BASE_URL === undefined || BASE_URL === "" || MODEL === undefined || MODEL === "") {
  console.log("skip: 1（env 凭证缺席——P12 opt-in：X_HARNESS_E2E_REAL_API_KEY / _BASE_URL / _MODEL）");
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), "xh-real-"));
try {
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [
    sessionPlugin,
    createJsonlSessionPersistence({ root }),
    toolsPlugin,
    llmPlugin,
    systemPromptPlugin,
    agentLoopPlugin,
    sessionCheckpointPlugin,
  ]);
  const off = ctx.use(llmRuntime).registerAdapter(createOpenaiCompatAdapter({ baseUrl: BASE_URL, apiKey: API_KEY }));
  ctx.effect(off);
  const made = await ctx.use(agentLoopServiceToken).create({
    session: { id: "real-smoke" as SessionId },
    agent: { model: MODEL, provider: "openai-compat", maxTokens: 256 },
  });
  must(made.ok, `agent 创建（实际：${made.ok === false ? made.reason : "ok"}）`);
  if (made.ok) {
    made.value.agent.followup("Reply with exactly the word: pong");
    await made.value.agent.whenIdle();
    const events = made.value.agent.session.events();
    const assistant = events.find((e) => e.type === "assistant/message");
    const text = JSON.stringify(assistant?.data ?? {});
    must(text !== "{}", `真模型有非空回应（实际：${text.slice(0, 200)}）`);
    must(JSON.stringify(events.at(-1)?.data).includes('"completed"'), "turn completed 收轮");
    await made.value.dispose();
    const disk = readFileSync(join(root, "real-smoke", "events.jsonl"), "utf8");
    must(disk.includes('"user/message"') && disk.includes('"assistant/message"'), "jsonl 落盘含完整往返");
    console.log("real: 1 通过（真凭证单 turn 冒烟 + 落盘）");
  }
  await ctx.dispose();
  void unload;
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
