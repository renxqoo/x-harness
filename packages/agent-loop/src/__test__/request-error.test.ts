// agentRequestError 决策集与 attempt 改道（docs/WORK-ERROR-RECOVERY.md C1）：形状门四路
// （合法 respond / 合法 fail / content 空 / 垃圾对象）；attempt 改道三路（respond →
// agent/message 落卷 + continue 进下一迭代、fail → fatal 带 code、undefined → 现行
// fatal 缺省 + settlement.code 透传修复）。

import { describe, expect, it, beforeEach } from "vitest";
import { agentRequestError } from "../index.ts";
import { isFailRequestDecision, isRespondDecision } from "../continuation.ts";
import { errorScript, makeWorld, resetWorlds, spawn, textScript, worlds } from "./world.ts";

beforeEach(() => {
  resetWorlds();
});

describe("request-error 决策形状门（C1）", () => {
  it("合法 respond：kind + 非空 content", () => {
    expect(isRespondDecision({ kind: "respond-to-model", content: "The request failed. Adjust and retry." })).toBe(true);
  });

  it("合法 fail：kind + 非空 message + 非空 code", () => {
    expect(isFailRequestDecision({ kind: "fail", message: "auth expired", code: "auth" })).toBe(true);
  });

  it("respond content 空串 / 字段缺失 → false", () => {
    expect(isRespondDecision({ kind: "respond-to-model", content: "" })).toBe(false);
    expect(isRespondDecision({ kind: "respond-to-model" })).toBe(false);
    expect(isFailRequestDecision({ kind: "fail", message: "", code: "auth" })).toBe(false);
    expect(isFailRequestDecision({ kind: "fail", message: "m", code: "" })).toBe(false);
  });

  it("垃圾对象 / null / 跨 kind → false", () => {
    expect(isRespondDecision({ kind: "retry" })).toBe(false);
    expect(isRespondDecision(null)).toBe(false);
    expect(isRespondDecision("respond-to-model")).toBe(false);
    expect(isFailRequestDecision({ kind: "respond-to-model", content: "x" })).toBe(false);
    expect(isFailRequestDecision(undefined)).toBe(false);
  });
});

describe("attempt 改道（C1：respond/fail/让位三路）", () => {
  it("respond → agent/message{content, error-recovery} 落卷、下一迭代请求投影携带、AttemptResult continue（不 fatal）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    const off = world.ctx.on(agentRequestError, async (payload: unknown, next: (input: unknown) => Promise<unknown>) => {
      const downstream = await next(payload);
      return downstream !== undefined ? downstream : { kind: "respond-to-model", content: "The request failed with E1. Adjust and retry." };
    });
    world.fake.scripts.push(errorScript("E1", "E_TIMEOUT"), textScript("recovered"));
    agent.followup("hi");
    await agent.whenIdle();
    off();
    const events = agent.session.events();
    const recoveries = events.filter((e) => e.type === "agent/message");
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]?.data).toEqual({
      turn: 0,
      step: 0,
      source: "error-recovery",
      kind: "content",
      content: [{ type: "text", text: "The request failed with E1. Adjust and retry." }],
    });
    // 下一迭代照常完成（continue 未收轮）：终态 completed、请求投影末条为错误消息
    expect(events.at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
    const lastRequest = world.fake.calls.at(-1);
    const lastRole = lastRequest?.messages.at(-1);
    expect(JSON.stringify(lastRole)).toContain("The request failed with E1");
    await handle.dispose();
  });

  it("fail → fatal 收轮且终态带 code", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    const off = world.ctx.on(agentRequestError, async (payload: unknown, next: (input: unknown) => Promise<unknown>) => {
      const downstream = await next(payload);
      return downstream !== undefined ? downstream : { kind: "fail", message: "auth expired", code: "auth" };
    });
    world.fake.scripts.push(errorScript("E1", "E_TIMEOUT"));
    agent.followup("hi");
    await agent.whenIdle();
    off();
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "error", message: "auth expired", code: "auth" } });
    await handle.dispose();
  });

  it("rawReason 三级透传（WER C4）：error finish 携 rawReason → attempt 结算 → RequestFailure.failure.rawReason 到达插件面", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    let seenRaw: string | undefined | "unset" = "unset";
    let seenCode: string | undefined | "unset" = "unset";
    const off = world.ctx.on(agentRequestError, async (payload: unknown, next: (input: unknown) => Promise<unknown>) => {
      const downstream = await next(payload);
      if (downstream !== undefined) return downstream;
      const failure = (payload as { failure: { code?: string; rawReason?: string } }).failure;
      seenRaw = failure.rawReason;
      seenCode = failure.code;
      return { kind: "fail", message: "stop", code: "test" };
    });
    world.fake.scripts.push((async function* (): AsyncGenerator<import("@x-harness/llm").LlmChunk> {
      yield { type: "finish", finish: { kind: "error", message: "boom", code: "http-500", rawReason: "model_context_window_exceeded" } };
    })());
    agent.followup("hi");
    await agent.whenIdle();
    off();
    expect(seenRaw).toBe("model_context_window_exceeded");
    expect(seenCode).toBe("http-500");
    await handle.dispose();
  });

  it("undefined 让位 → 现行 fatal 缺省；settlement.code 不再丢失（透传进终态）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    world.fake.scripts.push(errorScript("E1", "E_TIMEOUT"));
    agent.followup("hi");
    await agent.whenIdle();
    expect(agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "error", message: "E_TIMEOUT:E1", code: "E_TIMEOUT" } });
    await handle.dispose();
  });
});
