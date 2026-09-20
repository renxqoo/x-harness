// 异常终态语义（docs/SUBAGENT-FAILURE-NOTIFICATION.md）：异常收轮后自动链式终止
// （排队 next-turn 原地保留、不烧追加模型调用、不推迟真 idle）；锁存唤醒 replay 是用户
// 主动唤醒语义照常放行且不发假 idle；blocked 原因透传的垃圾决策防御。
// 排队构造必须在 kick 启动前直接向 session 预插 next-turn（step0 只领队首）——飞行中
// followup 会锁存 wakeRequested 走 replay 豁免、inject 落 next-step，都锚不到链式条件。

import type { LlmChunk } from "@x-harness/llm";
import type { ContentBlock } from "@x-harness/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentPreStep, agentStatus } from "../index.ts";
import { insertData } from "../inbox.ts";
import { makeWorld, resetWorlds, spawn, textScript, worlds } from "./world.ts";

beforeEach(() => {
  resetWorlds();
});

/** kick 前向 session 预插 next-turn 排队消息（不唤醒——链式条件的直读面） */
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
        await gate; // 挂起流：稳住飞行窗口
        yield { type: "finish", finish: { kind: "error", message: "boom" } };
      })(),
    );
    const { agent, handle } = await spawn(world);
    queueNextTurn(agent, "claimed-head");
    queueNextTurn(agent, "queued-during-error");
    agent.steer("go"); // idle 态唤醒（不锁存）——step0 领 next-turn 队首 + steer 文本
    await vi.waitFor(() => expect(world.fake.calls.length).toBe(1), { timeout: 5_000 });
    release();
    await agent.whenIdle();
    const turnEnds = agent.session.events().filter((e) => e.type === "turn/end");
    expect(turnEnds.at(-1)?.data).toMatchObject({ reason: { kind: "error", message: "boom" } });
    expect(world.fake.calls).toHaveLength(1); // 不链式：排队的 next-turn 没烧第二次模型调用
    expect(turnEnds).toHaveLength(1);
    // 排队消息原地保留（不丢）；steer 再唤醒后 step0 领队首消费
    world.fake.scripts.push(textScript("recovered"));
    agent.steer("wake");
    await agent.whenIdle();
    expect(agent.session.events().filter((e) => e.type === "turn/start")).toHaveLength(2);
    expect(world.fake.calls).toHaveLength(2);
    const secondTurnUsers = agent.session.events().filter((e) => e.type === "user/message" && (e.data as { turn?: number }).turn === 1);
    const batch = JSON.stringify(secondTurnUsers);
    expect(batch).toContain("queued-during-error"); // 队首被消费
    expect(batch).toContain("wake"); // steer 文本同批领取
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
        yield { type: "finish", finish: { kind: "max-tokens" } }; // 无文本无工具：content 空撞上限
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
    agent.followup("queued-mid-flight"); // 飞行中到达：锁存 wakeRequested
    release();
    await agent.whenIdle();
    off();
    expect(world.fake.calls).toHaveLength(2); // replay 消费了排队的 followup
    expect(agent.session.events().filter((e) => e.type === "turn/start")).toHaveLength(2);
    const secondTurnUsers = agent.session.events().filter((e) => e.type === "user/message" && (e.data as { turn?: number }).turn === 1);
    expect(JSON.stringify(secondTurnUsers)).toContain("queued-mid-flight");
    // replay 边界不发假 idle：状态序列 running→running→idle（无中间 idle 闪断——
    // 同步监听者（evictIdle/邮箱镜像）不得在「即将继续」的边界上做生命周期决策）
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
      return undefined as never; // waterfall 不校验输出形状的常见笔误形态
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
