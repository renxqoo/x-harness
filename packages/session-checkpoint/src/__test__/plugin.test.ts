// 语义持久检查点全链（docs/SESSION-CHECKPOINT §4）：真实装配 session+jsonl 持久化+tools+llm+
// system-prompt+agent-loop+checkpoint；假适配器与工具体在执行体内读 jsonl 文件——「先持久后派发」的
// 时点证明；fail-closed 双边界（不可写 root）。

import { mkdtemp, rm } from "node:fs/promises";
import { chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Context, Plugin } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { Type } from "@sinclair/typebox";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolRegistry } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import type { Agent, AgentHandle, AgentLoopService } from "@x-harness/agent-loop";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionCheckpointPlugin } from "../plugin.ts";

interface World {
  ctx: Context;
  loop: AgentLoopService;
  registry: ToolRegistry;
  fake: { calls: LlmRequest[]; scripts: Array<AsyncGenerator<LlmChunk>> };
  cleanup: () => Promise<void>;
}

const AGENT = { model: "fake-model", provider: "fake" };

async function makeWorld(root: string, withPersistence: boolean): Promise<World> {
  const ctx = createContext();
  const fake = { calls: [] as LlmRequest[], scripts: [] as Array<AsyncGenerator<LlmChunk>> };
  const plugins: Plugin[] = [sessionPlugin, toolsPlugin, llmPlugin, systemPromptPlugin, agentLoopPlugin, sessionCheckpointPlugin];
  if (withPersistence) {
    plugins.splice(1, 0, createJsonlSessionPersistence({ root, onIoError: () => {} }));
  }
  const unload = await loadPlugins(ctx, plugins);
  const off = ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: (request) => {
      fake.calls.push(request);
      const next = fake.scripts.shift();
      return next ?? textScript("(no script)");
    },
  });
  ctx.effect(off);
  return {
    ctx,
    loop: ctx.use(agentLoopServiceToken),
    registry: ctx.use(toolRegistry),
    fake,
    cleanup: async () => {
      await ctx.dispose();
      void unload;
    },
  };
}

function textScript(text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

function toolScript(callId: string, name: string, args: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "tool-call-delta", index: 0, callId, name, argumentsDelta: args };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

async function spawn(world: World): Promise<{ handle: AgentHandle; agent: Agent }> {
  const made = await world.loop.create({ agent: AGENT });
  expect(made.ok).toBe(true);
  if (!made.ok) throw new Error(made.reason);
  return { handle: made.value, agent: made.value.agent };
}

let root: string;
let worlds: World[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "xh-ckpt-"));
});

afterEach(async () => {
  for (const world of worlds) await world.cleanup().catch(() => {});
  worlds = [];
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("session-checkpoint（docs/SESSION-CHECKPOINT §1）", () => {
  it("请求边界：适配器派发时请求前缀（system+user/message）已在盘", async () => {
    const world = await makeWorld(root, true);
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    const file = join(root, agent.session.id, "events.jsonl");
    // 假适配器在流内读盘：派发时点的前缀可见性
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        const disk = readFileSync(file, "utf8");
        yield { type: "text-delta", text: disk.includes('"user/message"') ? "disk-has-user" : "disk-missing" };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    );
    agent.followup("hi");
    await agent.whenIdle();
    const assistant = agent.session.events().find((e) => e.type === "assistant/message");
    const blocks = ((assistant ?? { data: undefined }).data as unknown as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
    expect(blocks[0]?.text).toBe("disk-has-user");
    await handle.dispose();
  });

  it("请求边界 fail-closed：flush 失败 → turn/end{error} 且适配器零派发", async () => {
    chmodSync(root, 0o555); // root 不可写 → 打开文件即败
    const world = await makeWorld(root, true);
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    agent.followup("hi");
    await agent.whenIdle();
    expect(world.fake.calls).toHaveLength(0);
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "error" } });
    const end = agent.session.events().at(-1);
    const reason = (end?.data as { reason?: { message?: string } } | undefined)?.reason;
    expect(reason?.message).toContain("checkpoint-flush-failed");
    chmodSync(root, 0o755); // 恢复可写供 afterEach 清理
    await handle.dispose();
  });

  it("工具边界：工具体执行前 tool/call 已在盘", async () => {
    const world = await makeWorld(root, true);
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    const file = join(root, agent.session.id, "events.jsonl");
    world.registry.register({
      name: "probe",
      inputSchema: Type.Object({}),
      execute: async () => {
        const disk = readFileSync(file, "utf8");
        return { content: disk.includes('"tool/call"') ? "disk-has-call" : "disk-missing" };
      },
    });
    world.fake.scripts.push(toolScript("c1", "probe", "{}"), textScript("done"));
    agent.followup("go");
    await agent.whenIdle();
    const result = agent.session.events().find((e) => e.type === "tool/result");
    expect(result?.data).toMatchObject({ callId: "c1", content: "disk-has-call" });
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
    await handle.dispose();
  });

  it("工具边界 fail-closed 与无 session 直通：flush 失败工具体零执行、isError 携带 reason；无 session 不受影响", async () => {
    await import("node:fs").then((fs) => fs.chmodSync(root, 0o555));
    const world = await makeWorld(root, true);
    worlds.push(world);
    const made = await world.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const agent = made.value.agent;
    const execute = vi.fn(async () => ({ content: "ran" }));
    world.registry.register({ name: "side", inputSchema: Type.Object({}), execute });
    const controller = new AbortController();
    // 带 session：flush 失败 → 工具体零执行、isError、reason 可见（不借「未调 next」违约文本）
    const withSession = await world.registry.dispatch({
      callId: "c1",
      name: "side",
      args: {},
      signal: controller.signal,
      session: agent.session.id,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(withSession.isError).toBe(true);
    expect(withSession.content).toContain("checkpoint-flush-failed");
    // 不带 session：非 agent 调用方直通
    const withoutSession = await world.registry.dispatch({ callId: "c2", name: "side", args: {}, signal: controller.signal });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(withoutSession).toMatchObject({ content: "ran" });
    chmodSync(root, 0o755);
    await made.value.dispose();
  });

  it("空屏障：未装持久化插件时 flush 成功（不承诺字节），旅程照常", async () => {
    const world = await makeWorld(root, false);
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    world.fake.scripts.push(textScript("ok"));
    agent.followup("hi");
    await agent.whenIdle();
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
    await handle.dispose();
  });
});

