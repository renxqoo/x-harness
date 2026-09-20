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
import type { SessionId } from "@x-harness/session";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { Type } from "@sinclair/typebox";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolRegistry } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import type { Agent, AgentHandle, AgentLoopService } from "@x-harness/agent-loop";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionCheckpointPlugin } from "../plugin.ts";
import { checkpointDiagnostic } from "../tokens.ts";

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

  it("turn 收尾边界：turn 完成后盘上已含 assistant/message 与 turn/end（症状：崩溃丢最后一轮）", async () => {
    const world = await makeWorld(root, true);
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    world.fake.scripts.push(textScript("done"));
    agent.followup("hi");
    await agent.whenIdle(); // 不 dispose——证明收尾屏障自身落盘，而非 dispose 兜底
    const file = join(root, agent.session.id, "events.jsonl");
    const diskLines = (): string[] => readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
    const hasEventType = (lines: readonly string[], type: string): boolean =>
      lines.some((line) => line.includes(`"type":"${type}"`));
    // turn 收尾 flush 是异步告警式屏障，whenIdle 不承诺 fsync 完成：轮询等待 drain 落定
    const eventTypeOf = (line: string): string => line.match(/"type":"([^"]+)"/)?.[1] ?? "(unparsed)";
    const lines = await vi.waitFor(
      async () => {
        const disk = diskLines();
        if (!hasEventType(disk, "assistant/message") || !hasEventType(disk, "turn/end")) {
          throw new Error(`盘上缺 assistant/message/turn/end 行，当前行集 ${disk.map(eventTypeOf).join(",")}`);
        }
        return disk;
      },
      { timeout: 5000, interval: 25 },
    );
    expect(lines.at(-1)).toContain('"turn/end"'); // 末行即收尾：防 drain 乱序假绿
    await handle.dispose();
  });

  it("turn 收尾告警式：flush 失败告警且不阻断收尾，同会话只告警一次", async () => {
    chmodSync(root, 0o555); // root 不可写 → 打开文件即败（请求屏障 fail-closed + turn 收尾 flush 失败）
    const world = await makeWorld(root, true);
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const diagnostics: string[] = [];
    world.ctx.on(checkpointDiagnostic, (payload) => diagnostics.push(payload.code)); // 双通道：事件总线面
    try {
      agent.followup("hi");
      await agent.whenIdle();
      agent.followup("again");
      await agent.whenIdle();
      // 两个 turn 均以 error 收尾（请求屏障 fail-closed），收尾链本身不被 turn-end flush 失败阻断
      const ends = agent.session.events().filter((e) => e.type === "turn/end");
      expect(ends).toHaveLength(2);
      expect(ends.every((e) => (e.data as { reason?: { kind?: string } }).reason?.kind === "error")).toBe(true);
      const warnHits = (): number =>
        stderr.mock.calls.filter((call) => String(call[0]).includes("turn-end-flush-failed")).length;
      await vi.waitFor(() => {
        if (warnHits() === 0) throw new Error("turn-end-flush-failed 告警未出现");
        expect(warnHits()).toBe(1); // 两次收尾、一次告警：同会话去重
      }, { timeout: 5000, interval: 25 });
      expect(diagnostics).toEqual(["turn-end-flush-failed"]); // 诊断事件与 stderr 同步送达且同样去重
    } finally {
      stderr.mockRestore();
      chmodSync(root, 0o755); // 恢复可写供 afterEach 清理
    }
    await handle.dispose();
  });

  it("turn 收尾告警式：告警通道自身异常被 catch 兜住并重告送达（不产生 unhandled rejection）", async () => {
    chmodSync(root, 0o555);
    const world = await makeWorld(root, true);
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    const stderr = vi.spyOn(process.stderr, "write");
    stderr.mockImplementationOnce(() => {
      throw new Error("stderr broken");
    });
    stderr.mockReturnValue(true);
    const diagnostics: string[] = [];
    world.ctx.on(checkpointDiagnostic, (payload) => diagnostics.push(payload.code));
    try {
      agent.followup("hi");
      await agent.whenIdle(); // 若 .catch 缺席：then 内 throw → unhandled rejection → vitest 直接判败
      // 闩位在送达成功之后：首次 write 被吞后 catch 重告必须送达，而非被去重闩静默
      const delivered = (): boolean =>
        stderr.mock.calls.some((call) => String(call[0]).includes("warn-channel-failed"));
      await vi.waitFor(() => {
        if (!delivered()) throw new Error("通道故障后 catch 重告未送达（闩被误置）");
      }, { timeout: 5000, interval: 25 });
      expect(diagnostics).toEqual(["turn-end-flush-failed"]); // 诊断事件面同样送达
      expect(agent.session.events().at(-1)?.type).toBe("turn/end"); // 收尾链不受影响
    } finally {
      stderr.mockRestore();
      chmodSync(root, 0o755);
    }
    await handle.dispose();
  });

  it("turn 收尾告警去重按会话生命周期：dispose 后同 id 重生会话失败再告警", async () => {
    chmodSync(root, 0o555);
    const world = await makeWorld(root, true);
    worlds.push(world);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const warnHits = (): number =>
      stderr.mock.calls.filter((call) => String(call[0]).includes("turn-end-flush-failed")).length;
    try {
      const first = await world.loop.create({ agent: AGENT, session: { id: "revive-me" as SessionId } });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      first.value.agent.followup("hi");
      await first.value.agent.whenIdle();
      await vi.waitFor(() => {
        if (warnHits() === 0) throw new Error("第一代会话告警未出现");
      }, { timeout: 5000, interval: 25 });
      chmodSync(root, 0o755);
      await first.value.dispose(); // → sessionDisposed → 去重闩随会话摘除
      chmodSync(root, 0o555);
      const second = await world.loop.create({ agent: AGENT, session: { id: "revive-me" as SessionId } });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      second.value.agent.followup("again");
      await second.value.agent.whenIdle();
      await vi.waitFor(() => {
        if (warnHits() < 2) throw new Error("重生会话未再告警（去重闩未随生命周期摘除）");
      }, { timeout: 5000, interval: 25 });
      await second.value.dispose();
    } finally {
      stderr.mockRestore();
      chmodSync(root, 0o755);
    }
  });
});

