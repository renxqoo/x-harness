// 流式管线本地模拟器（零成本，无真实模型）：进程内 anthropic SSE 假服务器 × 全链真实插件栈。
// 用法：bun packages/e2e/stream-sim.ts [smooth|lump]
//   smooth = 每帧 8ms 均匀下发（理想上游）；lump = 116 帧/坨、坨间 1.3s（GLM 实测签名）。
// 观察：smooth 模式下若终端逐帧上屏 → 管线与显示面无罪，「一段一段」只能来自上游到达节奏；
//       lump 模式复刻观感，可与真实端点行为对照。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { createContext, loadPlugins } from "@x-harness/core";
import { createAnthropicCompatAdapter, llmPlugin, llmRuntime } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { agentAssistantStream, agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { sessionCheckpointPlugin } from "@x-harness/session-checkpoint";

const MODE = process.argv[2] === "lump" ? "lump" : "smooth";
const THINK_FRAMES = 400;
const TEXT_FRAMES = 300;
const FRAMES_PER_LUMP = 116; // GLM 实测：每坨 ~116 帧（≈20KB 定长缓冲）
const LUMP_PAUSE_MS = 1300;
const FRAME_MS = 8; // GLM 实测：平滑段内 ~7-8ms/帧

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
const sse = (type: string, fields: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;

const server = Bun.serve({
  port: 0,
  fetch(req) {
    if (req.method !== "POST") return new Response("nope", { status: 404 });
    const stream = new ReadableStream({
      async start(controller) {
        const push = (line: string): void => controller.enqueue(new TextEncoder().encode(line));
        const pace = async (i: number): Promise<void> => {
          if (MODE === "smooth") await sleep(FRAME_MS);
          else if ((i + 1) % FRAMES_PER_LUMP === 0) await sleep(LUMP_PAUSE_MS);
        };
        push(sse("message_start", { message: { usage: { input_tokens: 10 } } }));
        push(sse("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }));
        for (let i = 0; i < THINK_FRAMES; i++) {
          push(sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: `思${String(i)} ` } }));
          await pace(i);
        }
        push(sse("content_block_stop", { index: 0 }));
        push(sse("content_block_start", { index: 1, content_block: { type: "text", text: "" } }));
        for (let i = 0; i < TEXT_FRAMES; i++) {
          push(sse("content_block_delta", { index: 1, delta: { type: "text_delta", text: `文${String(i)} ` } }));
          await pace(i);
        }
        push(sse("content_block_stop", { index: 1 }));
        push(sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: THINK_FRAMES + TEXT_FRAMES } }));
        push(sse("message_stop", {}));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  },
});

const root = await mkdtemp(join(tmpdir(), "xh-sim-"));
const withStore = !process.argv.includes("store=off"); // A/B：有无持久化（jsonl+checkpoint）对照
try {
  const ctx = createContext();
  const unload = await loadPlugins(
    ctx,
    withStore
      ? [sessionPlugin, createJsonlSessionPersistence({ root }), toolsPlugin, llmPlugin, systemPromptPlugin, agentLoopPlugin, sessionCheckpointPlugin]
      : [sessionPlugin, toolsPlugin, llmPlugin, systemPromptPlugin, agentLoopPlugin],
  );
  const adapter = createAnthropicCompatAdapter({ baseUrl: `http://127.0.0.1:${String(server.port)}`, apiKey: "sim" });
  const off = ctx.use(llmRuntime).registerAdapter(adapter);
  ctx.effect(off);

  ctx.use(toolRegistry).register({
    name: "output",
    description: "把给定文本作为本会话的正式输出展示给用户",
    inputSchema: Type.Object({ text: Type.String() }),
    execute: async () => ({ content: "ok" }),
  });

  const made = await ctx.use(agentLoopServiceToken).create({
    session: { id: "sim" as SessionId },
    agent: { model: "sim-model", provider: adapter.name, maxTokens: 4096 },
  });
  if (!made.ok) throw new Error(made.reason);

  const t0 = Date.now();
  const frames: Array<{ t: number; kind: "T" | "A" }> = [];
  let lastKind: "text" | "thinking" | undefined;
  const tty = process.stdout.isTTY === true;
  const offStream = ctx.on(agentAssistantStream, (payload) => {
    if (payload.frame.phase !== "chunk") return;
    frames.push({ t: Date.now() - t0, kind: payload.frame.kind === "thinking" ? "T" : "A" });
    if (lastKind !== undefined && lastKind !== payload.frame.kind) process.stdout.write("\n");
    lastKind = payload.frame.kind;
    process.stdout.write(payload.frame.kind === "thinking" && tty ? `\x1b[2m${payload.frame.text}\x1b[0m` : payload.frame.text);
  });
  ctx.effect(offStream);

  made.value.agent.followup("你好！请写一段话。");
  await made.value.agent.whenIdle();

  console.log(`\n== 模拟器（${MODE}${withStore ? "" : "，无持久化"}）监听器到达统计 ==`);
  for (const kind of ["T", "A"] as const) {
    const run = frames.filter((f) => f.kind === kind);
    if (run.length === 0) continue;
    const buckets = new Map<number, number>();
    for (const f of run) buckets.set(Math.floor(f.t / 200), (buckets.get(Math.floor(f.t / 200)) ?? 0) + 1);
    console.log(`${kind === "T" ? "思考" : "正文"}：${String(run.length)} 帧（${run[0].t}ms → ${run[run.length - 1].t}ms）`);
    console.log(`  200ms 桶：${[...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, n]) => `${(b * 200).toString().padStart(5)}ms:${String(n)}`).join(" ")}`);
  }

  await made.value.dispose();
  await ctx.dispose();
  void unload;
} finally {
  server.stop(true);
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
