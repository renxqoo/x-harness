// 通知路径与门禁补全：error/blocked 透传、busy 步边界、重唤醒复占、占位通知、纯函数直测。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmChunk } from "@x-harness/llm";
import type { AgentHandle } from "@x-harness/agent-loop";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, CHILD_MODEL, makeOptions, workerOptions, resetWorlds, agentIdOf, sessionOf } from "./world.ts";
import type { World } from "./world.ts";
import { createNotifier } from "../notify.ts";

beforeEach(() => {
  resetWorlds();
});

const turnCountOf = (parent: AgentHandle): number =>
  parent.agent.session.events().filter((e) => e.type === "turn/start").length;

const listStatus = async (world: World, parent: AgentHandle, agentId: string): Promise<string | undefined> => {
  const listed = await callTool({ world, name: "list_agents", args: {}, session: parent.agent.session.id });
  const line = listed.content.split("\n").find((entry) => entry.includes(agentId));
  return line?.match(/status=(\w+)/)?.[1];
};

describe("通知路径（error 透传/busy 步边界/重唤醒复占）", () => {
  it("子 error turn → 通知显式 failed + 错误信息 + session id（X10）；error 轮不回潮前轮摘要", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "t1")]);
    parent.agent.followup("go");
    await parent.agent.whenIdle();
    world.scripts.set(CHILD_MODEL, [
      textScript(CHILD_MODEL, "first turn output"),
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "finish", finish: { kind: "error", message: "boom", code: "test" } };
      })(),
    ]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    await vi.waitFor(() => expect(turnCountOf(parent)).toBe(2), { timeout: 5_000 });
    world.scripts.set(PARENT_MODEL, [...(world.scripts.get(PARENT_MODEL) ?? []), textScript(PARENT_MODEL, "after-error")]);
    const agentId = agentIdOf(spawned.content);
    const messaged = await callTool({ world, name: "agent_message", args: { to: agentId, message: "again" }, session: parent.agent.session.id });
    expect(messaged.isError).toBeUndefined();
    expect(messaged.content).toContain("Delivered");
    await vi.waitFor(() => expect(turnCountOf(parent)).toBe(3), { timeout: 5_000 });
    const lastNotification = JSON.stringify(parent.agent.session.events().filter((e) => e.type === "user/message").at(-1)?.data);
    // settleStream 把 finish.code 前缀折进 attempt 错误串（"test:boom"）——通知如实透传该串
    expect(lastNotification).toContain(`agent ${agentId} failed: test:boom`);
    expect(lastNotification).toContain(`session: ${String(sessionOf(spawned.content))}`);
    expect(lastNotification).not.toContain("first turn output"); // error 轮不回潮前轮摘要
    await parent.dispose();
  });

  it("症状回归：子代理 max-tokens 空产出（content:[]——事故 20260920T130824 形态）→ 通知显式 failed + no summary + session id，主代理零轮询即知成败", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "t1")]);
    parent.agent.followup("go");
    await parent.agent.whenIdle();
    world.scripts.set(CHILD_MODEL, [
      (async function* (): AsyncGenerator<LlmChunk> {
        // 全输出为不可见增量（thinking）或直接截断：content 空、撞上限
        yield { type: "usage", usage: { input: 3742, output: 8192, totalTokens: 11934 } };
        yield { type: "finish", finish: { kind: "max-tokens" } };
      })(),
    ]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "diagnose", subagent_type: "worker" }, session: parent.agent.session.id });
    const lastUserText = (): string => JSON.stringify(parent.agent.session.events().filter((e) => e.type === "user/message").at(-1)?.data);
    await vi.waitFor(() => expect(lastUserText()).toContain("[agent-notification]"), { timeout: 5_000 });
    const lastNotification = lastUserText();
    const agentId = agentIdOf(spawned.content);
    expect(lastNotification).toContain(`agent ${agentId} failed: hit the output token limit before producing any report (no summary)`);
    expect(lastNotification).toContain(`session: ${String(sessionOf(spawned.content))}`);
    expect(lastNotification).toContain('\\"output\\":8192'); // 外层 stringify 转义后的 usage 行
    // task_output 同口径：显式 failed + session 行（完整报告面）
    const probed = await callTool({ world, name: "task_output", args: { task_id: agentId, block: false, timeout: 0 }, session: parent.agent.session.id });
    expect(probed.isError).toBeUndefined();
    expect(probed.content).toContain("failed: hit the output token limit");
    expect(probed.content).toContain(`session: ${String(sessionOf(spawned.content))}`);
    // 失败子代理保持 idle 可唤醒（不 dispose 不自动 stop）：list 状态 idle + message 可投递
    const listed = await callTool({ world, name: "list_agents", args: {}, session: parent.agent.session.id });
    expect(listed.content).toContain(`${agentId}`);
    expect(listed.content.match(new RegExp(`${agentId}[^\\n]*status=(\\w+)`))?.[1]).toBe("idle");
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "revived after failure")]);
    const revived = await callTool({ world, name: "agent_message", args: { to: agentId, message: "try again" }, session: parent.agent.session.id });
    expect(revived.isError).toBeUndefined();
    expect(revived.content).toContain("Delivered");
    await parent.dispose();
  });

  it("回归：message 重唤醒的子复占槽——maxConcurrent=1 下再 spawn 被拒", async () => {
    const world = await makeWorld(await makeOptions({ worker: { model: CHILD_MODEL } }, { maxConcurrent: 1 }));
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
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    const agentId = agentIdOf(spawned.content);
    await vi.waitFor(() => expect(turnCountOf(parent)).toBe(1), { timeout: 5_000 });
    const messaged = await callTool({ world, name: "agent_message", args: { to: agentId, message: "more" }, session: parent.agent.session.id });
    expect(messaged.isError).toBeUndefined();
    await vi.waitFor(async () => expect(await listStatus(world, parent, agentId)).toBe("running"), { timeout: 5_000 });
    const denied = await callTool({ world, name: "agent_spawn", args: { description: "d2", prompt: "y" }, session: parent.agent.session.id });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("concurrency limit reached");
    release();
    await parent.dispose();
  });

  it("父 busy 时通知步边界消费：turn 数不变，当前 turn 后续 step 的 user/message 含通知", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    let releaseParent!: () => void;
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "child finished fast")]);
    world.scripts.set(PARENT_MODEL, [
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "tool-call-delta", index: 0, callId: "sc1", name: "agent_spawn", argumentsDelta: JSON.stringify({ description: "d", prompt: "work", subagent_type: "worker" }) };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
      (async function* (): AsyncGenerator<LlmChunk> {
        await parentGate;
        yield { type: "text-delta", text: "resumed" };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
      textScript(PARENT_MODEL, "consumed notification"),
    ]);
    parent.agent.followup("spawn one");
    const stepCount = (): number => parent.agent.session.events().filter((e) => e.type === "step/start").length;
    await vi.waitFor(() => expect(stepCount()).toBe(2), { timeout: 5_000 });
    releaseParent();
    await parent.agent.whenIdle();
    const events = parent.agent.session.events();
    expect(events.filter((e) => e.type === "turn/start")).toHaveLength(1);
    const stepUsers = events.filter((e) => e.type === "user/message");
    expect(stepUsers.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(stepUsers.at(-1)?.data)).toContain("[agent-notification]");
    expect(events.at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
    await parent.dispose();
  });

  it("子会话缺档 → 占位通知如实送达（session-archived，不静默丢 completion）", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const row = { agentId: "agent-deadbeef", sessionId: "session-x" as never, name: "ghost", type: "worker", parent: parent.agent.session.id, depth: 1, occupied: false, armed: true, running: false, stopped: false };
    const store = world.ctx.use((await import("@x-harness/session")).sessionStore);
    const loop = world.loop;
    const finished: Array<{ outcome: string; detail: string }> = [];
    const notifier = createNotifier({
      loop,
      store,
      getRow: (session) => (session === row.sessionId ? row : undefined),
      isTearingDown: () => false,
      adoptOrphan: async () => {},
      emitFinished: (payload) => finished.push({ outcome: payload.outcome, detail: payload.detail }),
    });
    notifier({ session: row.sessionId, status: "running" });
    notifier({ session: row.sessionId, status: "idle" }); // store.get(session-x) undefined → 占位路径
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "consume")]);
    const lastUserText = (): string => {
      const events = parent.agent.session.events().filter((e) => e.type === "user/message");
      return JSON.stringify(events.at(-1)?.data);
    };
    await vi.waitFor(() => expect(lastUserText()).toContain("session-archived"), { timeout: 5_000 });
    expect(lastUserText()).toContain("session: session-x"); // 占位通知同样带 session 行（档案指针）
    // 占位路径的周期终结事件（BATCH2 §3）：idle 边沿已证跑完一轮 → completed + 缺档句
    expect(finished).toContainEqual({ outcome: "completed", detail: "session-archived (no report available)" });
    await parent.dispose();
  });
});

describe("动词入参防线（invalid-args 分支）", () => {
  it("缺参 → TypeBox 拦截且回显字段名；无 session 调 list → 拒", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const noTo = await callTool({ world, name: "agent_message", args: { message: "hi" }, session: parent.agent.session.id });
    expect(noTo.isError).toBe(true);
    expect(noTo.content).toContain("to");
    // message 为 schema 必填（spec 对齐）——缺参由 TypeBox 拦截
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x" }, session: parent.agent.session.id });
    const bare = await callTool({ world, name: "agent_message", args: { to: (spawned.content.match(/agent-[0-9a-f]{8}/) ?? [""])[0] }, session: parent.agent.session.id });
    expect(bare.isError).toBe(true);
    expect(bare.content).toContain("message");
    const outNoId = await callTool({ world, name: "task_output", args: {}, session: parent.agent.session.id });
    expect(outNoId.isError).toBe(true);
    expect(outNoId.content).toContain("task_id");
    const stopNoId = await callTool({ world, name: "task_stop", args: {}, session: parent.agent.session.id });
    expect(stopNoId.isError).toBe(true);
    const direct = await world.registry.dispatch({ callId: "d2", name: "list_agents", args: {}, signal: new AbortController().signal });
    expect(direct.isError).toBe(true);
    expect(direct.content).toContain("inside an agent session");
    await parent.dispose();
  });

  it("spawn 空 prompt / 空 description → invalid-args", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const emptyPrompt = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "" }, session: parent.agent.session.id });
    expect(emptyPrompt.isError).toBe(true);
    expect(emptyPrompt.content).toContain("non-empty string");
    const emptyDescription = await callTool({ world, name: "agent_spawn", args: { description: "  ", prompt: "x" }, session: parent.agent.session.id });
    expect(emptyDescription.isError).toBe(true);
    expect(emptyDescription.content).toContain("non-empty string");
    await parent.dispose();
  });
});

describe("reportText 三分支（纯函数直测）", () => {
  it("无摘要/短摘要/截断", async () => {
    const { reportText } = await import("../verbs.ts");
    const row = { agentId: "agent-9", sessionId: "sess-9" } as never;
    expect(reportText(row, { status: "aborted", summary: undefined, usage: undefined }, 10)).toContain("stopped: cancelled");
    expect(reportText(row, { status: "aborted", summary: undefined, usage: undefined, cause: "agent-stop" }, 10)).toContain("stopped: agent-stop");
    expect(reportText(row, { status: "completed", summary: "short", usage: undefined }, 10)).toContain("short");
    expect(reportText(row, { status: "completed", summary: "0123456789ABCDEF", usage: undefined }, 10)).toContain("truncated at 10");
    expect(reportText(row, { status: "completed", summary: "s", usage: undefined }, 10)).toContain("session: sess-9");
  });
});

describe("五态通知词表（表驱动——docs/SUBAGENT-FAILURE-NOTIFICATION.md）", () => {
  it("notificationText/reportText：每态前缀 + 原因句透传 + session 行", async () => {
    const { childReport, notificationText, failureDetail } = await import("../notify.ts");
    const { reportText } = await import("../verbs.ts");
    const row = { agentId: "agent-abcd1234", sessionId: "20260920T130824-ljcg3f" } as never;
    const mk = (reason: unknown, blocks: Array<{ type: string; text?: string }> = []): ReturnType<typeof childReport> =>
      childReport([
        { type: "assistant/message", seq: 0, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: blocks, stopReason: "stop" } },
        { type: "turn/end", seq: 1, time: 1, data: { turn: 0, reason } },
      ] as never);
    const table: ReadonlyArray<{ readonly name: string; readonly report: ReturnType<typeof childReport>; readonly head: string; readonly detail: string }> = [
      { name: "completed", report: mk({ kind: "completed" }, [{ type: "text", text: "all done" }]), head: "finished", detail: "completed" },
      { name: "max-tokens 无摘要", report: mk({ kind: "max-tokens" }), head: "failed", detail: "hit the output token limit before producing any report (no summary)" },
      { name: "max-tokens 有摘要", report: mk({ kind: "max-tokens" }, [{ type: "text", text: "partial" }]), head: "failed", detail: "hit the output token limit (last output may be truncated)" },
      { name: "error message+code", report: mk({ kind: "error", message: "boom", code: "net" }), head: "failed", detail: "boom (code: net)" },
      { name: "error 裸 message", report: mk({ kind: "error", message: "boom" }), head: "failed", detail: "boom" },
      { name: "aborted cause", report: mk({ kind: "aborted", cause: "user-stop" }), head: "stopped", detail: "user-stop" },
      { name: "aborted 无 cause", report: mk({ kind: "aborted" }), head: "stopped", detail: "cancelled" },
      { name: "interrupted（repair 残卷铸造态）", report: mk({ kind: "interrupted" }), head: "failed", detail: "turn interrupted before completing (crash recovery)" },
      { name: "blocked reason", report: mk({ kind: "blocked", reason: "compact-in-flight" }), head: "failed", detail: "step rejected by middleware: compact-in-flight" },
      { name: "blocked 无 reason", report: mk({ kind: "blocked" }), head: "failed", detail: "step rejected by middleware" },
    ];
    for (const row0 of table) {
      expect(failureDetail(row0.report)).toBe(row0.detail);
      const text = notificationText(row, row0.report);
      expect(text).toContain(`agent-abcd1234 ${row0.head}`);
      expect(text).toContain(row0.head === "finished" ? "finished: completed\n" : `${row0.head}: ${row0.detail}\n`);
      expect(text).toContain("session: 20260920T130824-ljcg3f");
      expect(text).toContain("task_output");
      const report = reportText(row, row0.report, 1000);
      expect(report).toContain("session: 20260920T130824-ljcg3f");
      if (row0.head !== "finished") expect(report).toContain(`${row0.detail}\n`);
      else expect(report).toContain("last turn: completed\n");
    }
    // error message 缺席兜底 + 未知 kind fail-closed
    expect(failureDetail({ status: "error", summary: undefined, usage: undefined })).toBe("turn ended with error");
    expect(failureDetail({ status: "weird-kind", summary: undefined, usage: undefined })).toBe("turn ended abnormally (unknown reason kind)");
  });

  it("childReport：summary 全文捕获（200 截断归展示层）/usage 捕获/无 turn-end fail-closed；原因字段从 turn/end 透传", async () => {
    const { childReport, notificationText } = await import("../notify.ts");
    const { reportText } = await import("../verbs.ts");
    const long = "x".repeat(300);
    const events = [
      { type: "assistant/message", seq: 0, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [{ type: "text", text: long }], usage: { input: 5, output: 6 }, stopReason: "stop" } },
      { type: "turn/end", seq: 1, time: 1, data: { turn: 0, reason: { kind: "completed" } } },
    ] as never;
    const report = childReport(events);
    expect(report.status).toBe("completed");
    expect(report.summary).toBe(long); // 全文——在此截断会让 reportCap 层形同虚设（全文恒 200+…）
    expect(report.usage).toEqual({ input: 5, output: 6 });
    const row = { agentId: "a", sessionId: "s1" } as never;
    const text = notificationText(row, report);
    expect(text).toContain(`summary: ${"x".repeat(200)}…`); // 通知摘要行：展示层 200
    expect(text).not.toContain("x".repeat(201));
    expect(text).toContain("usage:");
    expect(text).toContain("task_output");
    expect(reportText(row, report, 1000)).toContain(long); // 报告层：全文按 reportCap 截
    const bare = childReport([{ type: "assistant/message", seq: 0, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [], stopReason: "stop" } }] as never);
    expect(bare.status).toBe("error");
    const passthrough = childReport([
      { type: "turn/end", seq: 0, time: 1, data: { turn: 0, reason: { kind: "error", message: "m", code: "c" } } },
    ] as never);
    expect(passthrough.message).toBe("m");
    expect(passthrough.code).toBe("c");
    const causePassthrough = childReport([
      { type: "turn/end", seq: 0, time: 1, data: { turn: 0, reason: { kind: "aborted", cause: "killed" } } },
    ] as never);
    expect(causePassthrough.cause).toBe("killed");
  });

  it("viewStatus idle 态（list 视图三态收尾）", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    const agentId = agentIdOf(spawned.content);
    const stopped = await callTool({ world, name: "task_stop", args: { task_id: agentId }, session: parent.agent.session.id });
    expect(stopped.isError).toBeUndefined();
    const listed = await callTool({ world, name: "list_agents", args: {}, session: parent.agent.session.id });
    expect(listed.content).toContain("status=stopped");
    await parent.dispose();
  });
});
