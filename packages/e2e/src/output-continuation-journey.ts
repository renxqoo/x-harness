// e2e：输出截断续写全链旅程（docs/OUTPUT-TOKEN-CONTINUATION.md e2e 节，进默认门）。
// 真实装配 session+jsonl 持久化+tools+llm+system-prompt+agent-loop+agent-continuation 插件；
// 脚本化假 LLM 适配器。旅程A：两段截断→stop 续写（指令恰进续写请求末条、turn completed、
// WAL 指令为 agent/message{directive}）。旅程B：四连截断放弃（可恢复 error 终态）+
// 卷重开 resume 重放确定性（指令在投影、不重复注入）。
import { textScript } from "@x-harness/testkit";
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
import { createContinuationPlugin, OUTPUT_CONTINUATION_INSTRUCTION, OUTPUT_CONTINUATION_SOURCE } from "@x-harness/agent-continuation";
import { must } from "./check.ts";

interface AgentWorld {
  readonly ctx: Context;
  readonly calls: LlmRequest[];
  readonly scripts: Array<AsyncGenerator<LlmChunk>>;
  readonly agent: Agent;
}

const AGENT_DIAL = { model: "fake-model", provider: "fake" };

async function assembleWorld(root: string, sessionId?: SessionId): Promise<AgentWorld> {
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
    createContinuationPlugin(),
  ]);
  ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: (request) => {
      calls.push(request);
      return scripts.shift() ?? textScript("(no script)");
    },
  });
  const loop = ctx.use(agentLoopServiceToken);
  const made = sessionId === undefined ? await loop.create({ agent: AGENT_DIAL }) : await loop.resume({ id: sessionId, agent: AGENT_DIAL });
  must(made.ok, `agent spawn failed: ${made.ok ? "" : made.reason}`);
  if (!made.ok) throw new Error(made.reason);
  return { ctx, calls, scripts, agent: made.value.agent };
}

async function withWorld(visit: (world: AgentWorld, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "continuation-journey-"));
  try {
    const world = await assembleWorld(root);
    await visit(world, root);
    await world.ctx.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function directiveEvents(agent: Agent): Array<{ data: Record<string, unknown> }> {
  return agent.session.events().filter((event) => event.type === "agent/message") as never;
}

export async function runOutputContinuationJourney(): Promise<void> {
  // 旅程A：两段截断 → stop 续写完成
  await withWorld(async (world, root) => {
    world.scripts.push(textScript("part one ", "max-tokens"));
    world.scripts.push(textScript("part two ", "max-tokens"));
    world.scripts.push(textScript("part three, done"));
    world.agent.followup("write a long essay");
    await world.agent.whenIdle();

    must(world.calls.length === 3, `journey A: expected 3 requests, got ${String(world.calls.length)}`);
    for (const request of world.calls.slice(1)) {
      const last = request.messages.at(-1);
      must(
        last?.role === "user" && JSON.stringify(last.content).includes(OUTPUT_CONTINUATION_INSTRUCTION.slice(0, 24)),
        "journey A: continuation request must end with the instruction message",
      );
    }
    const directives = directiveEvents(world.agent);
    must(directives.length === 2, `journey A: expected 2 agent/message, got ${String(directives.length)}`);
    for (const directive of directives) {
      must(directive.data.source === OUTPUT_CONTINUATION_SOURCE && directive.data.kind === "directive", "journey A: directive shape");
    }
    const turnEnd = world.agent.session.events().at(-1);
    must(JSON.stringify(turnEnd?.data).includes('"completed"'), `journey A: turn must complete, got ${JSON.stringify(turnEnd?.data)}`);
    const sessionId = world.agent.session.id;

    // 旅程B（同卷重开）：resume 重放确定性——指令在投影、不重复注入；续写段语义终止（无新截断）
    await world.ctx.dispose();
    const reopened = await assembleWorld(root, sessionId);
    try {
      const directiveCount = directiveEvents(reopened.agent).length;
      must(directiveCount === 2, `journey B: replay must not duplicate directives, got ${String(directiveCount)}`);
      const projected = reopened.agent.session.deriveMessages().filter((message) => JSON.stringify(message).includes(OUTPUT_CONTINUATION_INSTRUCTION.slice(0, 24)));
      must(projected.length === 2, `journey B: projection must carry both directives, got ${String(projected.length)}`);
      reopened.scripts.push(textScript("new turn"));
      reopened.agent.followup("next question");
      await reopened.agent.whenIdle();
      const newDirectives = directiveEvents(reopened.agent).length;
      must(newDirectives === 2, `journey B: fresh turn must not inject stale directive, got ${String(newDirectives)}`);
    } finally {
      await reopened.ctx.dispose();
    }
  });

  // 旅程C：四连截断 → 放弃（可恢复 error 终态；stopReason 逐条 max-tokens）
  await withWorld(async (world) => {
    for (const segment of ["s1 ", "s2 ", "s3 ", "s4 "]) world.scripts.push(textScript(segment, "max-tokens"));
    world.agent.followup("write forever");
    await world.agent.whenIdle();

    must(world.calls.length === 4, `journey C: expected 4 requests, got ${String(world.calls.length)}`);
    must(directiveEvents(world.agent).length === 3, "journey C: exactly 3 resumes before give-up");
    const partials = world.agent.session.events().filter((event) => event.type === "assistant/message");
    must(partials.length === 4, `journey C: 4 partials must persist before give-up, got ${String(partials.length)}`);
    for (const partial of partials) {
      must((partial.data as { stopReason?: string }).stopReason === "max-tokens", "journey C: partial stopReason max-tokens");
    }
    const turnEnd = world.agent.session.events().at(-1)?.data as { reason: { kind: string; message?: string; code?: string } };
    must(turnEnd.reason.kind === "error", `journey C: turn must end error, got ${turnEnd.reason.kind}`);
    must(turnEnd.reason.code === "output-token-limit", `journey C: error code, got ${String(turnEnd.reason.code)}`);
    must(turnEnd.reason.message === "The model's response exceeded the output token maximum.", "journey C: error message");
  });
}
