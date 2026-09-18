// e2e 跨进程旅程的对端宿主程序（真子进程）：装配 harness（mailbox box "peer"、main 会话
// "peer-main"）；假适配器脚本：第一轮收到消息后经 agent_message 回信 alpha；随后空闲。
// 生命周期由父旅程控制（stdin 关闭即退出——无孤儿进程）。

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin } from "@x-harness/tools";
import { agentLoopPlugin } from "@x-harness/agent-loop";
import { createAgentDelegationPlugin } from "@x-harness/agent-delegation";
import { createMailboxPlugin } from "@x-harness/session-mailbox";

const MAILBOX_ROOT = process.argv[2] ?? "";
if (MAILBOX_ROOT === "") {
  console.error("cross-peer: mailbox root required");
  process.exit(1);
}

const agentsDir = await mkdtemp(join(tmpdir(), "xh-peer-agents-"));
const ctx = createContext();
const scripts = new Map<string, Array<AsyncGenerator<LlmChunk>>>();
const unload = await loadPlugins(ctx, [
  sessionPlugin,
  toolsPlugin,
  llmPlugin,
  systemPromptPlugin,
  agentLoopPlugin,
  createMailboxPlugin({ root: MAILBOX_ROOT, timing: { pollIntervalMs: 40, heartbeatMs: 1_000, graceMs: 30_000, staleMs: 7 * 24 * 3_600_000, now: () => Date.now() } }),
  createAgentDelegationPlugin({ agentsDirs: [agentsDir], mailbox: { box: "peer", mainSession: "peer-main" as SessionId } }),
]);
const off = ctx.use(llmRuntime).registerAdapter({
  name: "fake",
  stream: (request: LlmRequest) =>
    scripts.get(request.model)?.shift() ??
    (async function* (): AsyncGenerator<LlmChunk> {
      yield { type: "finish", finish: { kind: "error", message: "peer-no-script", code: "e2e" } };
    })(),
});
void off;

const replyToolCall = (message: string): AsyncGenerator<LlmChunk> =>
  (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "tool-call-delta", index: 0, callId: "reply1", name: "agent_message", argumentsDelta: JSON.stringify({ to: "alpha", message }) };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
scripts.set("peer-model", [replyToolCall("peer ack from real subprocess")]);

const loop = ctx.use((await import("@x-harness/agent-loop")).agentLoopServiceToken);
const made = await loop.create({ session: { id: "peer-main" as SessionId }, agent: { model: "peer-model", provider: "fake" } });
if (!made.ok) {
  console.error("cross-peer: main session failed:", made.reason);
  process.exit(1);
}
console.log("cross-peer: ready");

// stdin 关闭 = 父旅程命令退出（detached spawn 下 stdin inherit 关闭即 EOF）
process.stdin.on("end", () => {
  void (async () => {
    await made.value.dispose();
    await ctx.dispose();
    void unload;
    process.exit(0);
  })();
});
process.stdin.resume();
