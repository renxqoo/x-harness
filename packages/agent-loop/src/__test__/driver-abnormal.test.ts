import type { LlmChunk } from "@x-harness/llm";
import type { ContentBlock } from "@x-harness/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentPreStep, agentStatus } from "../index.ts";
import { insertData } from "../inbox.ts";
import { makeWorld, resetWorlds, spawn, textScript, worlds } from "./world.ts";

beforeEach(() => {
  resetWorlds();
});

function queueNextTurn(agent: { session: { append: (type: never, data: never) => { ok: boolean } } }, text: string): void {
  const appended = agent.session.append("agent/inbox/spliced" as never, insertData("next-turn", [{ type: "text", text } as ContentBlock] as readonly ContentBlock[]) as never);
  expect(appended.ok).toBe(true);
}

describe("异常终态不链式（SUBAGENT-FAILURE-NOTIFICATION）", () => {
  it("回归：error 后排队 next-turn 原地保留、无追加模型调用，唤醒后消费（可区分锚：旧实现此态链式）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        await gate;
        yield { type: "finish", finish: { kind: "error", message: "boom" } };
      })(),
    );
    const { agent, handle } = await spawn(world);
    queueNextTurn(agent, "claimed-head");
    queueNextTurn(agent, "queued-during-error");
    agent.steer("go");
    await vi.waitFor(() => expect(world.fake.calls.length).toBe(1), { timeout: 5_000 });
    release();
    await agent.whenIdle();
    const turnEnds = agent.session.events().filter((e) => e.type === "turn/end");
    expect(turnEnds.at(-1)?.data).toMatchObject({ reason: { kind: "error", message: "boom" } });
    expect(world.fake.calls).toHaveLength(1);
    expect(turnEnds).toHaveLength(1);
    world.fake.scripts.push(textScript("recovered"));
    agent.steer("wake");
    await agent.whenIdle();
    expect(agent.session.events().filter((e) => e.type === "turn/start")).toHaveLength(2);
    expect(world.fake.calls).toHaveLength(2);
    const secondTurnUsers = agent.session.events().filter((e) => e.type === "user/message" && (e.data as { turn?: number }).turn === 1);
    const batch = JSON.stringify(secondTurnUsers);
    expect(batch).toContain("queued-during-error");
    expect(batch).toContain("wake");
    await handle.dispose();
  });

  it("max-tokens 变体：空产出截断（事故 20260920T130824 形态），排队 next-turn 不被自动吞掉", async () => {
    const world = await makeWorld();
    worlds.push(world);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        await gate;
        yield { type: "finish", finish: { kind: "max-tokens" } };
      })(),
    );
    const { agent, handle } = await spawn(world);
    queueNextTurn(agent, "claimed-head");
    queueNextTurn(agent, "queued-during-cap");
    agent.steer("go");
    await vi.waitFor(() => expect(world.fake.calls.length).toBe(1), { timeout: 5_000 });
    release();
    await agent.whenIdle();
    const turnEnds = agent.session.events().filter((e) => e.type === "turn/end");
    expect(turnEnds.at(-1)?.data).toMatchObject({ reason: { kind: "max-tokens" } });
    expect(world.fake.calls).toHaveLength(1);
    expect(turnEnds).toHaveLength(1);
    await handle.dispose();
  });

  it("锁存唤醒 replay 照常（用户主动唤醒语义）：飞行中 followup 在 error 收轮后被消费，且边界不发假 idle", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const statuses: Array<{ session: unknown; status: string }> = [];
    const off = world.ctx.on(agentStatus, (payload: { session: unknown; status: string }) => statuses.push(payload));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        await gate;
        yield { type: "finish", finish: { kind: "error", message: "boom" } };
      })(),
      textScript("recovered"),
    );
    const { agent, handle } = await spawn(world);
    agent.followup("first");
    await vi.waitFor(() => expect(world.fake.calls.length).toBe(1), { timeout: 5_000 });
    agent.followup("queued-mid-flight");
    release();
    await agent.whenIdle();
    off();
    expect(world.fake.calls).toHaveLength(2);
    expect(agent.session.events().filter((e) => e.type === "turn/start")).toHaveLength(2);
    const secondTurnUsers = agent.session.events().filter((e) => e.type === "user/message" && (e.data as { turn?: number }).turn === 1);
    expect(JSON.stringify(secondTurnUsers)).toContain("queued-mid-flight");
    expect(statuses.map((s) => s.status)).toEqual(["running", "running", "idle"]);
    await handle.dispose();
  });
});

describe("blocked 原因透传的垃圾决策防御", () => {
  it("中间件返 undefined 决策 → blocked 如实无 reason，不炸（症状：TypeError 折平成 error 终态）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const off = world.ctx.on(agentPreStep, async (payload: unknown, next: (input: unknown) => Promise<unknown>) => {
      await next(payload);
      return undefined as never;
    });
    const { agent, handle } = await spawn(world);
    agent.followup("hi");
    await agent.whenIdle();
    off();
    const turnEnd = agent.session.events().filter((e) => e.type === "turn/end").at(-1);
    expect(turnEnd?.data).toEqual({ turn: 0, reason: { kind: "blocked" } });
    await handle.dispose();
  });

  it("reject reason 空串 → 省略落账（与 aborted.cause 同口径）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const off = world.ctx.on(agentPreStep, async (payload: unknown, next: (input: unknown) => Promise<unknown>) => {
      await next(payload);
      return { kind: "reject", reason: "" };
    });
    const { agent, handle } = await spawn(world);
    agent.followup("hi");
    await agent.whenIdle();
    off();
    const turnEnd = agent.session.events().filter((e) => e.type === "turn/end").at(-1);
    expect(turnEnd?.data).toEqual({ turn: 0, reason: { kind: "blocked" } });
    await handle.dispose();
  });
});
