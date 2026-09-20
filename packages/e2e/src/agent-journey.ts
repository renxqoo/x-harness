// e2e：agent 全链旅程（docs/SESSION-CHECKPOINT.md §2，P12 进默认门）。
// 真实装配 session+jsonl 持久化+tools+llm+system-prompt+agent-loop+session-checkpoint；
// 脚本化假 LLM 适配器。旅程：多步工具 turn（checkpoint 证据=流内读盘）→ steer 流中续航 →
// cancel 悬停流（aborted cause）→ 崩溃残卷 + 进程重开 resume（repair closers + 续卷）。
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { scriptedAdapter, textScript } from "@x-harness/testkit";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import type { Agent } from "@x-harness/agent-loop";
import { sessionCheckpointPlugin } from "@x-harness/session-checkpoint";
import { must } from "./check.ts";

interface Journey {
  ctx: Context;
  agent: Agent;
  sessionId: SessionId;
  scripts: Array<AsyncGenerator<LlmChunk>>;
  calls: LlmRequest[];
  noteCount: () => number;
}

/** 裸世界装配：插件 + 假适配器 + 假工具（resume 场景不预建会话——resume 自建 seed 会话） */
async function assembleWorld(root: string): Promise<Journey> {
  const ctx = createContext();
  const scripts: Array<AsyncGenerator<LlmChunk>> = [];
  const calls: LlmRequest[] = [];
  let notes = 0;
  await loadPlugins(ctx, [
    sessionPlugin,
    createJsonlSessionPersistence({ root }),
    toolsPlugin,
    llmPlugin,
    systemPromptPlugin,
    agentLoopPlugin,
    sessionCheckpointPlugin,
  ]);
  ctx.use(llmRuntime).registerAdapter(scriptedAdapter({ calls, scripts }));
  ctx.use(toolRegistry).register({
    name: "note",
    inputSchema: Type.Object({}),
    execute: async () => {
      notes += 1;
      return { content: `noted-${String(notes)}` };
    },
  });
  return { ctx, agent: undefined as unknown as Journey["agent"], sessionId: undefined as unknown as SessionId, scripts, calls, noteCount: () => notes };
}

/** 装配并创建 agent（会话 id 固定——跨「进程重开」续卷依赖稳定 id） */
async function assemble(root: string, id: SessionId): Promise<Journey> {
  const world = await assembleWorld(root);
  const made = await world.ctx.use(agentLoopServiceToken).create({ session: { id }, agent: { model: "fake-model", provider: "fake" } });
  must(made.ok, `agent 创建成功（实际：${made.ok === false ? made.reason : "ok"}）`);
  if (!made.ok) throw new Error(made.reason);
  return { ...world, agent: made.value.agent, sessionId: id };
}

const typesOf = (agent: Agent): string[] => agent.session.events().map((e) => e.type);
const diskEvents = (root: string, id: string): string => readFileSync(join(root, id, "events.jsonl"), "utf8");

export async function runAgentJourney(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "xh-agent-e2e-"));
  try {
    // —— 场景 1：多步工具 turn + checkpoint 证据（适配器流内读盘：请求前缀先持久后派发）——
    const j1 = await assemble(root, "main" as SessionId);
    try {
      j1.scripts.push(
        (async function* (): AsyncGenerator<LlmChunk> {
          const disk = diskEvents(root, "main");
          yield { type: "text-delta", text: disk.includes('"user/message"') ? "disk-ok " : "disk-missing " };
          yield { type: "tool-call-delta", index: 0, callId: "c1", name: "note", argumentsDelta: "{}" };
          yield { type: "finish", finish: { kind: "stop" } };
        })(),
        textScript("final answer"),
      );
      j1.agent.followup("remember this");
      await j1.agent.whenIdle();
      const t1 = typesOf(j1.agent);
      must(t1.includes("tool/call") && t1.includes("tool/result"), "多步工具 turn：tool/call 与 tool/result 落账");
      must(
        j1.agent.session.events().some((e) => e.type === "assistant/message" && JSON.stringify(e.data).includes("disk-ok")),
        "checkpoint 证据：适配器派发时 user/message 前缀已在盘",
      );
      must(j1.agent.session.events().at(-1)?.data != null && JSON.stringify(j1.agent.session.events().at(-1)?.data).includes('"completed"'), "turn completed 收轮");
      must(j1.noteCount() === 1, "工具副作用恰一次");
      console.log("旅程1：多步工具 turn + checkpoint 先持久后派发 通过");
    } finally {
      await j1.ctx.dispose();
    }

    // —— 场景 2：steer 流中注入 → 同 turn 续航消化 ——
    const j2 = await assemble(root, "steer" as SessionId);
    try {
      j2.scripts.push(
        (async function* (): AsyncGenerator<LlmChunk> {
          yield { type: "text-delta", text: "first" };
          j2.agent.steer("mid-turn correction");
          yield { type: "finish", finish: { kind: "stop" } };
        })(),
        textScript("steered"),
      );
      j2.agent.followup("go");
      await j2.agent.whenIdle();
      must(typesOf(j2.agent).filter((t) => t === "turn/start").length === 1, "steer 同 turn 续航");
      must(typesOf(j2.agent).filter((t) => t === "user/message").length === 2, "steer 内容被消化为 user/message");
      console.log("旅程2：steer 流中注入不搁浅 通过");
    } finally {
      await j2.ctx.dispose();
    }

    // —— 场景 3：cancel 悬停流 → interrupted 消息 + aborted cause ——
    const j3 = await assemble(root, "cancel" as SessionId);
    try {
      j3.scripts.push(
        (async function* (): AsyncGenerator<LlmChunk> {
          yield { type: "text-delta", text: "partial" };
          await new Promise(() => {}); // 悬停流
          yield { type: "finish", finish: { kind: "stop" } };
        })(),
      );
      j3.agent.followup("hi");
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      must(j3.calls.length === 1, "cancel 场景：适配器已派发一次");
      j3.agent.cancel("user-stop");
      await j3.agent.whenIdle();
      must(
        j3.agent.session.events().some((e) => e.type === "assistant/message" && JSON.stringify(e.data).includes('"interrupted":true')),
        "cancel：interrupted 消息保序落账",
      );
      must(
        JSON.stringify(j3.agent.session.events().at(-1)?.data).includes('"aborted"') && JSON.stringify(j3.agent.session.events().at(-1)?.data).includes("user-stop"),
        "cancel：turn/end aborted cause=user-stop",
      );
      console.log("旅程3：cancel 悬停流 → interrupted + aborted cause 通过");
    } finally {
      await j3.ctx.dispose();
    }

    // —— 场景 4：崩溃残卷（悬空 tool_use + 未闭合括号）→ 进程重开 → resume 修复续用 ——
    const crashedId = "crashed" as SessionId;
    const j4 = await assemble(root, crashedId);
    const log4 = j4.agent.session.append as unknown as (type: string, data: unknown, intent?: unknown) => { ok: boolean; reason?: string };
    must(log4("turn/start", { turn: 0 }).ok, "残卷：turn/start 落账");
    must(log4("step/start", { turn: 0, step: 0 }).ok, "残卷：step/start 落账");
    must(
      log4("assistant/message", { turn: 0, step: 0, content: [{ type: "tool_use", callId: "z1", name: "note", input: "{}" }], stopReason: "stop" }, { surfaceOp: "append" }).ok,
      "残卷：悬空 tool_use 落账",
    );
    const flushed = await j4.ctx.use(sessionStore).flush(crashedId);
    must(flushed.ok, `残卷 flush 落盘（实际：${flushed.ok === false ? flushed.reason : "ok"}）`);
    await j4.ctx.dispose(); // 「进程死亡」：日志无 turn/end/step/end——repair 的输入

    const j5 = await assembleWorld(root); // 「进程重开」：同 root 新装配（不预建会话——resume 自建）
    try {
      const resumed = await j5.ctx.use(agentLoopServiceToken).resume({ id: crashedId, agent: { model: "fake-model", provider: "fake" } });
      must(resumed.ok, `resume 成功（实际：${resumed.ok === false ? resumed.reason : "ok"}）`);
      if (resumed.ok) {
        const agent = resumed.value.agent;
        const t5 = typesOf(agent);
        // repair closers 入 seed：合成 tool/result（outcome unknown 两态之「已派发」不可判——此处无 tool/call → not started）+ 括号补齐
        must(t5.includes("tool/result"), "resume：悬空 tool_use 合成结果");
        must(t5.includes("session/end-seed"), "resume：seed 边界标记");
        const synthetic = agent.session.events().find((e) => e.type === "tool/result");
        must(JSON.stringify(synthetic?.data).includes("not started"), "resume：无 tool/call 记录 → not started 文案");
        // 修复后的会话继续可用
        j5.scripts.push(textScript("reborn"));
        agent.followup("after crash");
        await agent.whenIdle();
        must(typesOf(agent).filter((t) => t === "turn/start").length === 2, "resume 后新 turn 正常开启");
        must(JSON.stringify(agent.session.events().at(-1)?.data).includes('"completed"'), "resume 后 turn completed");
        await resumed.value.dispose();
        // 续卷：重开进程写的 turn 在盘（同 id 可验证续写）
        const disk = diskEvents(root, crashedId);
        must(disk.includes('"reborn"'), "同 id 续卷：resume 后的事件续写落盘");
      }
    } finally {
      await j5.ctx.dispose();
    }
    console.log("旅程4：崩溃残卷 → resume 修复（合成结果+括号补齐）→ 续用续卷 通过");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
