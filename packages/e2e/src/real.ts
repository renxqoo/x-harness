// e2e:real——真凭证全链观察脚本（docs/SESSION-CHECKPOINT.md §3，P12：opt-in）：一条「你好」+
// 自定义输出工具，流式帧实时上屏（agentAssistantStream：思考 dim、正文原色——docs/THINKING-STREAM.md）。
// env GLM_API_KEY + GLM_BASE_URL + GLM_MODEL 齐备才执行；缺席 = 显式 skip（退出码 0）。不进默认门。
import { mkdtemp, rm } from "node:fs/promises";
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
import { agentAssistantStream, agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { sessionCheckpointPlugin } from "@x-harness/session-checkpoint";

const API_KEY = process.env.GLM_API_KEY;
const BASE_URL = process.env.GLM_BASE_URL;
const MODEL = process.env.GLM_MODEL;
/** 协议闭集 {openai, anthropic}（缺省 openai；缺席不触发 skip——skip 三变量口径不变） */
const PROTOCOL = "anthropic";

if (API_KEY === undefined || API_KEY === "" || BASE_URL === undefined || BASE_URL === "" || MODEL === undefined || MODEL === "") {
  console.log("skip: 1（env 凭证缺席——P12 opt-in：GLM_API_KEY / GLM_BASE_URL / GLM_MODEL）");
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

  // 自定义输出工具：模型通过 tool_use 调用它，工具体真实执行并回传
  const outputs: string[] = [];
  ctx.use(toolRegistry).register({
    name: "output",
    description: "把给定文本作为本会话的正式输出展示给用户",
    inputSchema: Type.Object({ text: Type.String({ description: "要输出的内容" }) }),
    execute: async (args) => {
      const text = (args as { text: string }).text;
      outputs.push(text);
      return { content: `1111已输出==================>：${text}` };
    },
  });

  const made = await ctx.use(agentLoopServiceToken).create({
    session: { id: "real-smoke" as SessionId },
    agent: { model: MODEL, provider, maxTokens: 1024 },
  });
  if (!made.ok) throw new Error(`agent 创建失败：${made.reason}`);

  // 流式帧订阅（先于 followup——事件即发即弃无重放）：思考 dim、正文原色；
  // kind 切换与 attempt 边界换行。SMOOTH_CPS>0 时显示侧匀速放帧（打字机）——
  // 上游成坨到达时摊平观感，代价是显示滞后于真实到达（whenIdle 后排干余量）
  const smoothCps = Number(process.env.SMOOTH_CPS ?? "0");
  const tty = process.stdout.isTTY === true;
  let thinkingCount = 0;
  let textCount = 0;
  let lastKind: "text" | "thinking" | undefined;
  const pending: Array<{ kind: "text" | "thinking"; text: string }> = [];
  const writeFrame = (kind: "text" | "thinking", text: string): void => {
    if (lastKind !== undefined && lastKind !== kind) process.stdout.write("\n");
    lastKind = kind;
    process.stdout.write(kind === "thinking" && tty ? `\x1b[2m${text}\x1b[0m` : text);
  };
  const drain = (): void => {
    for (const frame of pending.splice(0)) writeFrame(frame.kind, frame.text);
  };
  const pacer =
    smoothCps > 0
      ? setInterval(() => {
          let budget = Math.max(1, Math.round((smoothCps * 16) / 1000));
          while (budget > 0 && pending.length > 0) {
            const head = pending[0] as { kind: "text" | "thinking"; text: string };
            const take = head.text.slice(0, budget);
            budget -= take.length;
            writeFrame(head.kind, take);
            if (take.length === head.text.length) pending.shift();
            else pending[0] = { kind: head.kind, text: head.text.slice(take.length) };
          }
        }, 16)
      : undefined;
  const offStream = ctx.on(agentAssistantStream, (payload) => {
    if (payload.frame.phase === "end" && payload.frame.kind === "attempt") {
      drain();
      process.stdout.write("\n");
      lastKind = undefined;
      return;
    }
    if (payload.frame.phase !== "chunk") return;
    if (payload.frame.kind === "thinking") thinkingCount += 1;
    else textCount += 1;
    if (pacer === undefined) writeFrame(payload.frame.kind, payload.frame.text);
    else pending.push({ kind: payload.frame.kind, text: payload.frame.text });
  });
  ctx.effect(offStream);

  made.value.agent.followup(
    "调用 output 工具",
  );
  await made.value.agent.whenIdle();
  if (pacer !== undefined) clearInterval(pacer);
  drain();


  await made.value.dispose();
  await ctx.dispose();
  void unload;
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
