// 截断已收内容落盘（docs/STREAM-PARTIAL-PERSISTENCE.md）：thinking 全路径落账 +
// attempt 已收正文增量落账 + 投影白名单不回传（请求体不泄漏锚）。
// 症状源：20260920T152852-xx03bt——34000 token 思考流终止后 WAL 零落盘。

import type { LlmChunk } from "@x-harness/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../index.ts";
import { makeWorld, resetWorlds, spawn, textScript, worlds } from "./world.ts";

beforeEach(() => {
  resetWorlds();
});

const lastEvent = (agent: Agent, type: string): Record<string, unknown> | undefined =>
  agent.session.events().filter((e) => e.type === type).at(-1)?.data as Record<string, unknown> | undefined;

describe("截断已收内容落盘（STREAM-PARTIAL-PERSISTENCE）", () => {
  it("症状回归：纯思考 + max-tokens（34000 token 零落盘形态）→ assistant/message 落 thinking 全文、content 空", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "thinking-delta", text: "considering ".repeat(3) };
        yield { type: "usage", usage: { input: 1, output: 34000 } };
        yield { type: "finish", finish: { kind: "max-tokens" } };
      })(),
    );
    const { agent, handle } = await spawn(world);
    agent.followup("diagnose");
    await agent.whenIdle();
    const message = lastEvent(agent, "assistant/message");
    expect(message).toMatchObject({ stopReason: "max-tokens" });
    expect(message?.["content"]).toEqual([]);
    expect(message?.["thinking"]).toBe("considering considering considering ");
    expect(message?.["usage"]).toEqual({ input: 1, output: 34000 });
    await handle.dispose();
  });

  it("症状回归：中止纯思考流 → assistant/attempt 落 thinking（不只 error 串）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "thinking-delta", text: "mid-thought" };
        await gate; // 挂起：等 cancel 打断
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    );
    const { agent, handle } = await spawn(world);
    agent.followup("go");
    await vi.waitFor(() => expect(world.fake.calls.length).toBe(1), { timeout: 5_000 });
    agent.cancel("user-stop");
    release();
    await agent.whenIdle();
    const attempt = lastEvent(agent, "assistant/attempt");
    expect(attempt?.["error"]).toBe("aborted");
    expect(attempt?.["thinking"]).toBe("mid-thought");
    await handle.dispose();
  });

  it("中止有正文与思考 → message{interrupted} 带 thinking + 正文", async () => {
    const world = await makeWorld();
    worlds.push(world);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "thinking-delta", text: "pondering" };
        yield { type: "text-delta", text: "partial answer" };
        await gate;
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    );
    const { agent, handle } = await spawn(world);
    agent.followup("go");
    await vi.waitFor(() => expect(world.fake.calls.length).toBe(1), { timeout: 5_000 });
    agent.cancel("user-stop");
    release();
    await agent.whenIdle();
    const message = lastEvent(agent, "assistant/message");
    expect(message).toMatchObject({ stopReason: "stop", interrupted: true });
    expect(message?.["content"]).toEqual([{ type: "text", text: "partial answer" }]);
    expect(message?.["thinking"]).toBe("pondering");
    await handle.dispose();
  });

  it("症状回归：流错误前已收正文与思考 → assistant/attempt 落 content 增量 + thinking（原来只有 error+usage）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "thinking-delta", text: "halfway" };
        yield { type: "text-delta", text: "draft text" };
        yield { type: "finish", finish: { kind: "error", message: "boom" } };
      })(),
    );
    const { agent, handle } = await spawn(world);
    agent.followup("go");
    await agent.whenIdle();
    const attempt = lastEvent(agent, "assistant/attempt");
    expect(attempt?.["error"]).toBe("boom");
    expect(attempt?.["content"]).toEqual([{ type: "text", text: "draft text" }]);
    expect(attempt?.["thinking"]).toBe("halfway");
    await handle.dispose();
  });

  it("回归：流错误前已收 tool-call-delta → attempt.content 含聚积 tool_use 增量（丢弃 tool_use 的变异曾全绿）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "thinking-delta", text: "planning" };
        yield { type: "tool-call-delta", index: 0, callId: "c7", name: "grep", argumentsDelta: '{"q":"' };
        yield { type: "tool-call-delta", index: 0, argumentsDelta: 'x"}' };
        yield { type: "finish", finish: { kind: "error", message: "net down" } };
      })(),
    );
    const { agent, handle } = await spawn(world);
    agent.followup("go");
    await agent.whenIdle();
    const attempt = lastEvent(agent, "assistant/attempt");
    expect(attempt?.["content"]).toEqual([{ type: "tool_use", callId: "c7", name: "grep", input: '{"q":"x"}' }]);
    expect(attempt?.["thinking"]).toBe("planning");
    await handle.dispose();
  });

  it("回归：纯思考 + finish(stop) 空结算 → attempt 落 thinking 且 content 缺席（空增量省略口径）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "thinking-delta", text: "all thought no output" };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    );
    const { agent, handle } = await spawn(world);
    agent.followup("go");
    await agent.whenIdle();
    const attempt = lastEvent(agent, "assistant/attempt");
    expect(attempt?.["error"]).toBe("empty completion");
    expect(attempt?.["thinking"]).toBe("all thought no output");
    expect(attempt).not.toHaveProperty("content");
    await handle.dispose();
  });

  it("正常 stop 有思考 → message.thinking 在场；后续请求体不回传思考（投影白名单锚）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "thinking-delta", text: "SECRET-THOUGHT" };
        yield { type: "text-delta", text: "visible answer" };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
      textScript("second turn"),
    );
    const { agent, handle } = await spawn(world);
    agent.followup("first");
    await agent.whenIdle();
    const message = lastEvent(agent, "assistant/message");
    expect(message?.["thinking"]).toBe("SECRET-THOUGHT");
    expect(message?.["content"]).toEqual([{ type: "text", text: "visible answer" }]);
    agent.followup("second");
    await agent.whenIdle();
    expect(world.fake.calls).toHaveLength(2);
    const secondRequest = JSON.stringify(world.fake.calls[1]?.messages ?? []);
    expect(secondRequest).toContain("visible answer"); // 可见正文照常回传
    expect(secondRequest).not.toContain("SECRET-THOUGHT"); // 思考落盘不回传
    await handle.dispose();
  });
});
