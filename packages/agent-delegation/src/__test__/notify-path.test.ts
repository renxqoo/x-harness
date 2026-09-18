// 通知路径与门禁补全（代码审 B 处置）：error/blocked 透传、busy 步边界、重唤醒复占、并行池三 spawn。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmChunk } from "@x-harness/llm";
import type { AgentHandle } from "@x-harness/agent-loop";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, CHILD_MODEL, OPTIONS, resetWorlds } from "./world.ts";
import type { World } from "./world.ts";

beforeEach(() => {
  resetWorlds();
});

const turnCountOf = (parent: AgentHandle): number =>
  parent.agent.session.events().filter((e) => e.type === "turn/start").length;

const listStatus = async (world: World, parent: AgentHandle, agentId: string): Promise<string | undefined> => {
  const listed = await callTool({ world, name: "list_agents", args: {}, session: parent.agent.session.id });
  const line = listed.content.split("\n").find((entry) => entry.startsWith(agentId));
  return line?.match(/status=(\w+)/)?.[1];
};

describe("通知路径补全（代码审 B 处置——error/blocked 透传/busy 步边界/重唤醒复占）", () => {
  it("子 error turn → 通知 status=error（X10）；aborted 轮不回潮前轮摘要", async () => {
    const world = await makeWorld(OPTIONS);
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "t1")]);
    parent.agent.followup("go");
    await parent.agent.whenIdle();
    // 子脚本：先完成一轮（有摘要），再 error 一轮（通知应报 error 且不回潮前轮摘要）
    world.scripts.set(CHILD_MODEL, [
      textScript(CHILD_MODEL, "first turn output"),
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "finish", finish: { kind: "error", message: "boom", code: "test" } };
      })(),
    ]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { prompt: "x", type: "worker" }, session: parent.agent.session.id });
    void spawned;
    // 第一轮完成通知（completed + 摘要）
    await vi.waitFor(() => expect(turnCountOf(parent)).toBe(2), { timeout: 5_000 });
    // 第二轮：手动 message 唤醒 → error 轮 → 通知 status=error 且无摘要回潮
    world.scripts.set(PARENT_MODEL, [...(world.scripts.get(PARENT_MODEL) ?? []), textScript(PARENT_MODEL, "after-error")]);
    const agentId = (spawned.content.match(/(agent-\d+)/) ?? [])[1] as string;
    const messaged = await callTool({ world, name: "agent_message", args: { agentId, text: "again" }, session: parent.agent.session.id });
    expect(messaged.isError).toBeUndefined(); // message 正向路径（B-P1-2 处置）
    expect(messaged.content).toContain("Delivered");
    await vi.waitFor(() => expect(turnCountOf(parent)).toBe(3), { timeout: 5_000 });
    const lastNotification = JSON.stringify(parent.agent.session.events().filter((e) => e.type === "user/message").at(-1)?.data);
    expect(lastNotification).toContain("finished: error");
    expect(lastNotification).not.toContain("first turn output"); // aborted/error 轮不回潮前轮摘要
    await parent.dispose();
  });

  it("回归：message 重唤醒的子复占槽——maxConcurrent=1 下再 spawn 被拒（审查 A-P1-1）", async () => {
    const world = await makeWorld({ ...OPTIONS, maxConcurrent: 1 });
    const parent = await spawnParent(world);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.scripts.set(CHILD_MODEL, [
      textScript(CHILD_MODEL, "done once"),
      (async function* (): AsyncGenerator<LlmChunk> {
        await gate; // 第二轮挂起：保持 running 占槽
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    ]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { prompt: "x", type: "worker" }, session: parent.agent.session.id });
    const agentId = (spawned.content.match(/(agent-\d+)/) ?? [])[1] as string;
    await vi.waitFor(() => expect(turnCountOf(parent)).toBe(1), { timeout: 5_000 }); // 完成通知（父未 followup——通知在收件箱）
    const messaged = await callTool({ world, name: "agent_message", args: { agentId, text: "more" }, session: parent.agent.session.id });
    expect(messaged.isError).toBeUndefined();
    await vi.waitFor(async () => expect(await listStatus(world, parent, agentId)).toBe("running"), { timeout: 5_000 });
    const denied = await callTool({ world, name: "agent_spawn", args: { prompt: "y" }, session: parent.agent.session.id });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("concurrency limit reached");
    release();
    await parent.dispose();
  });

  it("父 busy 时通知步边界消费：turn 数不变，当前 turn 后续 step 的 user/message 含通知", async () => {
    const world = await makeWorld(OPTIONS);
    const parent = await spawnParent(world);
    // 父第一轮：调 spawn 工具 + 悬停流（通知到达时父仍 busy）
    let releaseParent!: () => void;
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "child finished fast")]);
    world.scripts.set(PARENT_MODEL, [
      (async function* (): AsyncGenerator<LlmChunk> {
        yield {
          type: "tool-call-delta",
          index: 0,
          callId: "sc1",
          name: "agent_spawn",
          argumentsDelta: JSON.stringify({ prompt: "work", type: "worker" }),
        };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
      (async function* (): AsyncGenerator<LlmChunk> {
        await parentGate; // 第二步悬停：通知在此期间到达
        yield { type: "text-delta", text: "resumed" };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
      textScript(PARENT_MODEL, "consumed notification"), // 第三步：通知消化后的收尾
    ]);
    parent.agent.followup("spawn one");
    // 等父进入第二步悬停（step/start ≥2）后放行
    const stepCount = (): number => parent.agent.session.events().filter((e) => e.type === "step/start").length;
    await vi.waitFor(() => expect(stepCount()).toBe(2), { timeout: 5_000 });
    releaseParent();
    await parent.agent.whenIdle();
    const events = parent.agent.session.events();
    expect(events.filter((e) => e.type === "turn/start")).toHaveLength(1); // 通知未另起 turn（步边界消费）
    const stepUsers = events.filter((e) => e.type === "user/message");
    expect(stepUsers.length).toBeGreaterThanOrEqual(2); // 第一步 spawn 批 + 后续步通知
    expect(JSON.stringify(stepUsers.at(-1)?.data)).toContain("[agent-notification]"); // 通知在当前 turn 的后续 step 被消化
    expect(events.at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
    await parent.dispose();
  });
});

describe("动词入参防线（tools.ts invalid-args 分支）", () => {
  it("agent_message/agent_output/agent_stop 缺参 → invalid-args；无 session 调 list → 拒", async () => {
    const world = await makeWorld(OPTIONS);
    const parent = await spawnParent(world);
    // 缺参由 TypeBox 校验层拦截（回显违规——单一真相，工具体不再重复守卫）
    const noId = await callTool({ world, name: "agent_message", args: { text: "hi" }, session: parent.agent.session.id });
    expect(noId.isError).toBe(true);
    expect(noId.content).toContain("agentId");
    const noText = await callTool({ world, name: "agent_message", args: { agentId: "agent-1" }, session: parent.agent.session.id });
    expect(noText.isError).toBe(true);
    expect(noText.content).toContain("text");
    const outNoId = await callTool({ world, name: "agent_output", args: {}, session: parent.agent.session.id });
    expect(outNoId.isError).toBe(true);
    expect(outNoId.content).toContain("agentId");
    const stopNoId = await callTool({ world, name: "agent_stop", args: {}, session: parent.agent.session.id });
    expect(stopNoId.isError).toBe(true);
    const direct = await world.registry.dispatch({ callId: "d2", name: "list_agents", args: {}, signal: new AbortController().signal });
    expect(direct.isError).toBe(true);
    expect(direct.content).toContain("inside an agent session");
    await parent.dispose();
  });

  it("spawn 空 prompt → invalid-args", async () => {
    const world = await makeWorld(OPTIONS);
    const parent = await spawnParent(world);
    const empty = await callTool({ world, name: "agent_spawn", args: { prompt: "" }, session: parent.agent.session.id });
    expect(empty.isError).toBe(true);
    expect(empty.content).toContain("non-empty string");
    await parent.dispose();
  });
});

describe("reportText 三分支（纯函数直测）", () => {
  it("无摘要/短摘要/截断", async () => {
    const { reportText } = await import("../tools.ts");
    const row = { agentId: "agent-9", name: "w" } as never;
    expect(reportText(row, { status: "aborted", summary: undefined, usage: undefined }, 10)).toContain("(no assistant output in the last turn)");
    expect(reportText(row, { status: "completed", summary: "short", usage: undefined }, 10)).toContain("short");
    expect(reportText(row, { status: "completed", summary: "0123456789ABCDEF", usage: undefined }, 10)).toContain("truncated at 10");
  });
});

describe("通知细节分支（纯函数直测——覆盖回填）", () => {
  it("childReport：长摘要截断/usage 捕获/无 turn-end fail-closed；notificationText 含 usage 行", async () => {
    const { childReport, notificationText } = await import("../notify.ts");
    const long = "x".repeat(300);
    const events = [
      { type: "assistant/message", seq: 0, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [{ type: "text", text: long }], usage: { input: 5, output: 6 }, stopReason: "stop" } },
      { type: "turn/end", seq: 1, time: 1, data: { turn: 0, reason: { kind: "completed" } } },
    ] as never;
    const report = childReport(events);
    expect(report.status).toBe("completed");
    expect(report.summary?.length).toBe(201); // 200 + 省略号
    expect(report.usage).toEqual({ input: 5, output: 6 });
    const text = notificationText({ agentId: "a", name: "n" } as never, report);
    expect(text).toContain("usage:");
    expect(text).toContain("agent_output");
    // 无 turn/end：fail-closed error
    const bare = childReport([{ type: "assistant/message", seq: 0, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [], stopReason: "stop" } }] as never);
    expect(bare.status).toBe("error");
  });

  it("viewStatus idle 态（list 视图三态收尾）", async () => {
    const world = await makeWorld(OPTIONS);
    const parent = await spawnParent(world);
    const spawned = await callTool({ world, name: "agent_spawn", args: { prompt: "x", type: "worker" }, session: parent.agent.session.id });
    const agentId = (spawned.content.match(/(agent-\d+)/) ?? [])[1] as string;
    const stopped = await callTool({ world, name: "agent_stop", args: { agentId }, session: parent.agent.session.id });
    expect(stopped.isError).toBeUndefined();
    const listed = await callTool({ world, name: "list_agents", args: {}, session: parent.agent.session.id });
    expect(listed.content).toContain("status=stopped");
    await parent.dispose();
  });
});
