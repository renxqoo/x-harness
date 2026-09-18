// e2e:real——真凭证全链冒烟（docs/SESSION-CHECKPOINT.md §3，P12：opt-in）：一条「你好」+
// 自定义输出工具——验证 模型 tool_use → 工具体执行 → tool/result 回传 → 下一步完成 全链调通。
// env X_HARNESS_E2E_REAL_API_KEY + X_HARNESS_E2E_REAL_BASE_URL + X_HARNESS_E2E_REAL_MODEL 齐备才执行；
// 缺席 = 显式 skip（打印计数，退出码 0——缺席不是失败）。不进默认门。
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { createContext, loadPlugins } from "@x-harness/core";
import { createAnthropicCompatAdapter, createOpenaiCompatAdapter, llmPlugin, llmRuntime } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { sessionCheckpointPlugin } from "@x-harness/session-checkpoint";
import { must } from "./check.ts";

const API_KEY = process.env.X_HARNESS_E2E_REAL_API_KEY;
const BASE_URL = process.env.X_HARNESS_E2E_REAL_BASE_URL;
const MODEL = process.env.X_HARNESS_E2E_REAL_MODEL;
/** 协议闭集 {openai, anthropic}（缺省 openai；缺席不触发 skip——skip 三变量口径不变） */
const PROTOCOL_RAW = process.env.X_HARNESS_E2E_REAL_PROTOCOL ?? "openai";
if (PROTOCOL_RAW !== "openai" && PROTOCOL_RAW !== "anthropic") {
  console.error(`e2e:real 失败：X_HARNESS_E2E_REAL_PROTOCOL 非法值 "${PROTOCOL_RAW}"（闭集 {openai, anthropic}）`);
  process.exit(1);
}
const PROTOCOL = PROTOCOL_RAW;

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
  // BASE_URL 语义随协议：openai → {baseUrl}/chat/completions；anthropic → {baseUrl}/v1/messages
  const adapter =
    PROTOCOL === "anthropic"
      ? createAnthropicCompatAdapter({ baseUrl: BASE_URL, apiKey: API_KEY })
      : createOpenaiCompatAdapter({ baseUrl: BASE_URL, apiKey: API_KEY });
  const provider = adapter.name; // provider 名与 adapter.name 精确一致（no-adapter fail-closed）
  const off = ctx.use(llmRuntime).registerAdapter(adapter);
  ctx.effect(off);

  // 自定义输出工具：模型应通过 tool_use 调用它，工具体真实执行并回传
  const outputs: string[] = [];
  ctx.use(toolRegistry).register({
    name: "output",
    description: "把给定文本作为本会话的正式输出展示给用户",
    inputSchema: Type.Object({ text: Type.String({ description: "要输出的内容" }) }),
    execute: async (args) => {
      const text = (args as { text: string }).text;
      outputs.push(text);
      return { content: `已输出：${text}` };
    },
  });

  const made = await ctx.use(agentLoopServiceToken).create({
    session: { id: "real-smoke" as SessionId },
    agent: { model: MODEL, provider, maxTokens: 512 },
  });
  must(made.ok, `agent 创建（实际：${made.ok === false ? made.reason : "ok"}）`);
  if (made.ok) {
    made.value.agent.followup("你好！请调用 output 工具，text 参数填「你好，x-harness 全链已调通」，然后简短收尾。");
    await made.value.agent.whenIdle();
    const events = made.value.agent.session.events();

    // ① 模型确实发起了 tool_use（Anthropic/OpenAI 双协议的 callId/name 都进 tool/call）
    const calls = events.filter((e) => e.type === "tool/call");
    must(calls.some((e) => (e.data as { name?: string }).name === "output"), `模型调用了自定义 output 工具（实际调用：${JSON.stringify(calls.map((e) => e.data))}）`);

    // ② 工具体真实执行（副作用可观察）且结果回传模型
    must(outputs.length > 0, "output 工具体真实执行（副作用可观察）");
    const results = events.filter((e) => e.type === "tool/result");
    must(
      results.some((e) => String((e.data as { content?: string }).content).includes("你好，x-harness 全链已调通")),
      `tool/result 回传含工具体输出（实际：${JSON.stringify(results.map((e) => e.data))}）`,
    );

    // ③ 工具结果消化后 turn 正常收轮
    must(JSON.stringify(events.at(-1)?.data).includes('"completed"'), "工具结果消化后 turn completed 收轮");
    const stepCount = events.filter((e) => e.type === "step/start").length;
    must(stepCount >= 2, `多步链路（tool_use 步 + 消化步，实际 ${String(stepCount)} 步）`);

    await made.value.dispose();
    const disk = readFileSync(join(root, "real-smoke", "events.jsonl"), "utf8");
    must(
      disk.includes('"tool/call"') && disk.includes('"tool/result"') && disk.includes('"assistant/message"'),
      "jsonl 落盘含完整工具往返",
    );
    console.log(`real: 1 通过（${PROTOCOL} 协议真凭证全链：你好 → output 工具调用/执行/回传 → 完成；落盘 ✓）`);
    console.log(`output 工具收到的内容：${JSON.stringify(outputs)}`);
  }
  await ctx.dispose();
  void unload;
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
