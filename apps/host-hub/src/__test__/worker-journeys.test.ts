// worker 内嵌旅程 II（MIGRATION §5 worker-read-shapes/dial-journey/worker-bash/
// regressions-worker 对应行）：resume 旅程/读口族/bash 边界族/弹窗拒绝与超时/
// 子代理面（delegation spawn → get_subagents → steer）/压缩双发/stop→start 再用。
import { afterAll, describe, expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnScriptWorker, waitEvent, waitFrame, waitResponse } from "./kit/worker-harness.ts";
import type { ScriptWorker } from "./kit/worker-harness.ts";
import type { ScriptStep } from "../shared/script-adapter.ts";

const workers: ScriptWorker[] = [];
afterAll(async () => {
  for (const w of workers) w.input.end();
  await new Promise((resolve) => {
    setTimeout(resolve, 150);
  });
});

async function spawn(script: readonly ScriptStep[] = []): Promise<ScriptWorker> {
  const w = await spawnScriptWorker({ script });
  workers.push(w);
  return w;
}

async function start(w: ScriptWorker, id = "s1"): Promise<string> {
  w.send({ type: "thread/start", id });
  const started = await waitResponse(w.captured.lines, "thread/start", id);
  if (!started.success) throw new Error(String(started.error));
  return (started.data as { threadId: string }).threadId;
}

describe("worker 旅程 II", () => {
  test("resume 旅程：stop 后 resume 同会话（WAL 尾值恢复 thinking 档）+ cwd 回退 header", async () => {
    const w = await spawn([{ reply: "first" }]);
    const threadId = await start(w);
    w.send({ type: "set_thinking_level", id: "t1", threadId, level: "medium" });
    await waitResponse(w.captured.lines, "set_thinking_level", "t1");
    const sessionPath = join(w.sessionsRoot, threadId, "events.jsonl");
    w.send({ type: "thread/stop", id: "sp1", threadId });
    await waitResponse(w.captured.lines, "thread/stop", "sp1");
    // 坏路径先行：不安全 id
    w.send({ type: "thread/resume", id: "r2", sessionPath: join(w.sessionsRoot, "../escape") });
    const bad = await waitResponse(w.captured.lines, "thread/resume", "r2");
    expect(bad.error).toEqual({ code: "session_unreadable", message: "Session file not readable" });
    // resume：thinking 尾值恢复
    w.send({ type: "thread/resume", id: "r1", sessionPath });
    const resumed = await waitResponse(w.captured.lines, "thread/resume", "r1");
    expect(resumed.success).toBe(true);
    const newId = (resumed.data as { threadId: string }).threadId;
    expect(newId).toBe(threadId);
    w.send({ type: "get_thinking_level", id: "t2", threadId: newId });
    const got = await waitResponse(w.captured.lines, "get_thinking_level", "t2");
    expect(got.data).toEqual({ level: "medium", source: "session" });
  });

  test("resume 空 events.jsonl（合法空会话——header 在场）成功；档案缺席拒", async () => {
    const w = await spawn([]);
    const emptyDir = join(w.sessionsRoot, "emptyvol");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(emptyDir, { recursive: true });
    await writeFile(join(emptyDir, "header.json"), JSON.stringify({ id: "emptyvol", createdAt: 1 }), "utf8");
    await writeFile(join(emptyDir, "events.jsonl"), "", "utf8");
    w.send({ type: "thread/resume", id: "r1", sessionPath: join(emptyDir, "events.jsonl") });
    const resumed = await waitResponse(w.captured.lines, "thread/resume", "r1");
    expect(resumed.success).toBe(true); // 空卷合法（内核 create 先落 header）
    // 档案缺席（无 header/events）→ 拒（独立 worker——本会话已 open 占用先拒）
    const w2 = await spawn([]);
    w2.send({ type: "thread/resume", id: "r2", sessionPath: join(w2.sessionsRoot, "nope", "events.jsonl") });
    const missing = await waitResponse(w2.captured.lines, "thread/resume", "r2");
    expect(missing.error).toEqual({ code: "session_unreadable", message: "Session file not readable" });
    w2.input.end();
  });

  test("读口族：get_messages/get_tree/get_session_stats/get_fork_messages/set_session_name", async () => {
    const w = await spawn([{ reply: "answer" }]);
    const threadId = await start(w);
    w.send({ type: "prompt", id: "p1", threadId, message: "question" });
    await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p1");
    w.send({ type: "get_messages", id: "gm1", threadId });
    const messages = await waitResponse(w.captured.lines, "get_messages", "gm1");
    const list = (messages.data as { messages: Array<{ role: string }> }).messages;
    expect(list.some((m) => m.role === "user")).toBe(true);
    expect(list.some((m) => m.role === "assistant")).toBe(true);
    w.send({ type: "get_tree", id: "gt1", threadId });
    const tree = await waitResponse(w.captured.lines, "get_tree", "gt1");
    expect(tree.data).toEqual({ ancestors: [], children: [], leafSeq: expect.any(Number) });
    w.send({ type: "get_session_stats", id: "gs1", threadId });
    const stats = await waitResponse(w.captured.lines, "get_session_stats", "gs1");
    const sd = stats.data as { userMessages: number; assistantMessages: number; tokens: { input: number; output: number; total: number } };
    expect(sd.userMessages).toBeGreaterThanOrEqual(1);
    expect(sd.assistantMessages).toBeGreaterThanOrEqual(1);
    expect(sd.tokens.total).toBeGreaterThan(0);
    w.send({ type: "get_fork_messages", id: "gf1", threadId });
    const forkable = await waitResponse(w.captured.lines, "get_fork_messages", "gf1");
    expect((forkable.data as Array<{ text: string }>).some((entry) => entry.text.includes("question"))).toBe(true);
    w.send({ type: "set_session_name", id: "sn1", threadId, name: "" });
    const empty = await waitResponse(w.captured.lines, "set_session_name", "sn1");
    const emptyErr = empty.error as { code?: string; message?: string } | undefined;
    expect(emptyErr?.code).toBe("invalid_input");
    expect(emptyErr?.message).toContain("invalid name");
    w.send({ type: "set_session_name", id: "sn2", threadId, name: "my thread" });
    await waitResponse(w.captured.lines, "set_session_name", "sn2");
    w.send({ type: "get_state", id: "gs2", threadId });
    const state = await waitResponse(w.captured.lines, "get_state", "gs2");
    expect((state.data as { sessionName: string }).sessionName).toBe("my thread");
  });

  test("bash 边界族：确认拒绝/准入取消（abort_bash 弹窗期）/超时 cancelled/排除信封", async () => {
    const w = await spawn([]);
    const threadId = await start(w);
    // 确认拒绝 → permission denied
    w.send({ type: "bash", id: "b1", threadId, command: "echo no" });
    const req1 = await waitFrame(w.captured.lines, (f) => f.type === "ui_request" && f.method === "confirm");
    w.send({ type: "ui_response", id: "ur1", requestId: req1.requestId, payload: { confirmed: false } });
    const denied = await waitResponse(w.captured.lines, "bash", "b1");
    expect(denied.error).toEqual({ code: "bash_denied", message: "permission denied" });
    // 弹窗期 abort_bash → aborted before execution started
    w.send({ type: "bash", id: "b2", threadId, command: "echo late" });
    await waitFrame(w.captured.lines, (f) => f.type === "ui_request" && f.method === "confirm");
    w.send({ type: "abort_bash", id: "ab1", threadId });
    const aborted = await waitResponse(w.captured.lines, "bash", "b2");
    expect(aborted.error).toEqual({ code: "bash_denied", message: "aborted before execution started" });
    await waitResponse(w.captured.lines, "abort_bash", "ab1");
    // 超时 → cancelled:true 正常 success
    w.send({ type: "bash", id: "b3", threadId, command: "sleep 5", timeoutMs: 150 });
    const req3 = await waitFrame(w.captured.lines, (f) => f.type === "ui_request" && f.summary === "sleep 5");
    w.send({ type: "ui_response", id: "ur3", requestId: req3.requestId, payload: { confirmed: true } });
    const timed = await waitResponse(w.captured.lines, "bash", "b3");
    const td = timed.data as { cancelled: boolean; exitCode: number };
    expect(td.cancelled).toBe(true);
    // excludeFromContext：无信封
    const eventsBefore = (await readFile(join(w.sessionsRoot, threadId, "events.jsonl"), "utf8")).length;
    w.send({ type: "bash", id: "b4", threadId, command: "echo excluded", excludeFromContext: true });
    const req4 = await waitFrame(w.captured.lines, (f) => f.type === "ui_request" && f.summary === "echo excluded");
    w.send({ type: "ui_response", id: "ur4", requestId: req4.requestId, payload: { confirmed: true } });
    const excluded = await waitResponse(w.captured.lines, "bash", "b4");
    expect(excluded.success).toBe(true);
    const eventsAfter = (await readFile(join(w.sessionsRoot, threadId, "events.jsonl"), "utf8")).length;
    expect(eventsAfter).toBe(eventsBefore); // 不落信封
    // 空 command / 非法 timeout
    w.send({ type: "bash", id: "b5", threadId, command: "  " });
    const badCmd = await waitResponse(w.captured.lines, "bash", "b5");
    expect(badCmd.error).toEqual({ code: "invalid_input", message: "invalid command: required" });
    w.send({ type: "bash", id: "b6", threadId, command: "echo x", timeoutMs: -1 });
    const badTimeout = await waitResponse(w.captured.lines, "bash", "b6");
    const timeoutErr = badTimeout.error as { code?: string; message?: string } | undefined;
    expect(timeoutErr?.code).toBe("invalid_input");
    expect(timeoutErr?.message).toContain("invalid timeoutMs");
  });

  test("子代理面：agent_spawn 工具 → get_subagents 行 + subagent/steer 投递", async () => {
    const w = await spawn([
      { toolCalls: [{ name: "agent_spawn", input: '{"description":"research","prompt":"do work"}' }] },
      { reply: "parent continues" },
      { reply: "child works" },
    ]);
    // full 档起线程：agent_spawn 工具不弹窗（入参路径 + 授权面同步的旅程锚）
    w.send({ type: "thread/start", id: "s1", permissionMode: "full" });
    const startedFrame = await waitResponse(w.captured.lines, "thread/start", "s1");
    const threadId = (startedFrame.data as { threadId: string }).threadId;
    w.send({ type: "prompt", id: "p1", threadId, message: "spawn one" });
    await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p1");
    w.send({ type: "get_subagents", id: "sa1", threadId });
    const subs = await waitResponse(w.captured.lines, "get_subagents", "sa1");
    const rows = (subs.data as { subagents: Array<{ kind: string; agentId?: string; status: string; work?: string }> }).subagents;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.kind).toBe("subagent");
    expect(rows[0]?.work).toBe("research"); // work 链（T39 D10.2）：spawn description 直达 wire
    const agentId = rows[0]?.agentId ?? "";
    // steer 驻留目标（idle 唤醒语义）；未知目标拒
    w.send({ type: "subagent/steer", id: "ss1", threadId, agentId, message: "status update" });
    const steered = await waitResponse(w.captured.lines, "subagent/steer", "ss1");
    expect(steered.success).toBe(true);
    w.send({ type: "subagent/steer", id: "ss2", threadId, agentId: "agent-00000000", message: "x" });
    const missed = await waitResponse(w.captured.lines, "subagent/steer", "ss2");
    const missedErr = missed.error as { code?: string; message?: string } | undefined;
    expect(missedErr?.code).toBe("invalid_input");
    expect(missedErr?.message).toContain("not available");
  });

  test("compact 双发预检 + abort 命令路径", async () => {
    const w = await spawn([{ reply: "some context" }]);
    const threadId = await start(w);
    w.send({ type: "compact", id: "c1", threadId });
    const first = await waitResponse(w.captured.lines, "compact", "c1");
    expect(first.success).toBe(false); // 上下文太小
    expect(first.error).toEqual({ code: "compact_rejected", message: "context too small to compact" });
    // abort 全路径（无在飞也幂等成功）
    w.send({ type: "abort", id: "ab1", threadId });
    await waitResponse(w.captured.lines, "abort", "ab1");
  });

  test("流式中 fork/compact/set_thinking_level 拒（thread is streaming）", async () => {
    const w = await spawn([{ delayMs: 60_000 }]);
    const threadId = await start(w);
    w.send({ type: "prompt", id: "p1", threadId, message: "hold" });
    await waitEvent(w.captured.lines, "turn/start");
    // 流式拒分族：fork/set_thinking_level = 受理窗口（worker 面）；compact 经内核
    // busy 前置 = compact_rejected（message 同串）
    for (const [command, extra, code] of [
      ["fork", { seq: 0, position: "at" }, "streaming_window"],
      ["compact", {}, "compact_rejected"],
      ["set_thinking_level", { level: "high" }, "streaming_window"],
    ] as const) {
      w.send({ type: command, id: `x-${command}`, threadId, ...extra });
      const rejected = await waitResponse(w.captured.lines, command, `x-${command}`);
      expect(rejected.error).toEqual({ code, message: "thread is streaming" });
    }
    w.send({ type: "prompt", id: "p2", threadId, message: "must fail" });
    const noBehavior = await waitResponse(w.captured.lines, "prompt", "p2");
    expect(noBehavior.error).toEqual({ code: "streaming_window", message: "streamingBehavior required while streaming" });
  });

  test("fork 边界：seq 越界 / before 首事件 / 无效 seq", async () => {
    const w = await spawn([{ reply: "x" }]);
    const threadId = await start(w);
    w.send({ type: "prompt", id: "p1", threadId, message: "hi" });
    await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p1");
    w.send({ type: "fork", id: "f1", threadId, seq: 999 });
    const beyond = await waitResponse(w.captured.lines, "fork", "f1");
    expect(beyond.error).toEqual({ code: "cursor_stale", message: "fork beyond durable boundary" });
    w.send({ type: "fork", id: "f2", threadId, seq: 0 });
    const beforeFirst = await waitResponse(w.captured.lines, "fork", "f2");
    expect(beforeFirst.error).toEqual({ code: "invalid_input", message: "fork before first event" });
    w.send({ type: "fork", id: "f3", threadId, seq: -1 });
    const invalid = await waitResponse(w.captured.lines, "fork", "f3");
    const invalidErr = invalid.error as { code?: string; message?: string } | undefined;
    expect(invalidErr?.code).toBe("invalid_input");
    expect(invalidErr?.message).toContain("invalid fork seq");
  });

  test("stop→start 再用（同 worker 复用）", async () => {
    const w = await spawn([{ reply: "one" }, { reply: "two" }]);
    const first = await start(w, "s1");
    w.send({ type: "prompt", id: "p1", threadId: first, message: "hi" });
    await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p1");
    w.send({ type: "thread/stop", id: "sp1", threadId: first });
    await waitResponse(w.captured.lines, "thread/stop", "sp1");
    const second = await start(w, "s2");
    expect(second).not.toBe(first);
    w.send({ type: "prompt", id: "p2", threadId: second, message: "again" });
    await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p2");
  });
});

describe("子代理实时事件面（BATCH2 §3——去轮询：推送全覆盖）", () => {
  test("agent/spawned → agent/status → agent/finished 推送 + 子归属帧 agentName/session 字段", async () => {
    const w = await spawn([
      { toolCalls: [{ name: "agent_spawn", input: '{"description":"research","prompt":"do work"}' }] },
      { reply: "parent continues" },
      { reply: "child works" },
    ]);
    w.send({ type: "thread/start", id: "s1", permissionMode: "full" });
    const startedFrame = await waitResponse(w.captured.lines, "thread/start", "s1");
    const threadId = (startedFrame.data as { threadId: string }).threadId;
    w.send({ type: "prompt", id: "p1", threadId, message: "spawn one" });
    // ① spawned 推送（零轮询——客户端不再依赖 get_subagents 轮询感知）；work 链随载荷（T39 D10.2）
    const spawnedFrame = await waitEvent(w.captured.lines, "agent/spawned");
    const spawned = spawnedFrame.payload as { parent: string; agentId: string; sessionId: string; type: string; depth: number; work?: string };
    expect(spawned.parent).toBe(threadId);
    expect(spawned.type).toBe("untyped");
    expect(spawned.depth).toBe(1);
    expect(spawned.agentId).toMatch(/^agent-/);
    expect(spawned.work).toBe("research");
    // ② 子运行边沿（agent/status 带 session 归属）
    const childRun = await waitEvent(w.captured.lines, "agent/status", (p) => (p as { session?: string }).session === spawned.sessionId && (p as { status?: string }).status === "running");
    expect((childRun.payload as { session: string }).session).toBe(spawned.sessionId);
    // ③ 子 WAL 帧带 session 归属 + agentName（D1 修复面：外发可归属，不污染主线程状态）
    const childTurn = await waitEvent(w.captured.lines, "turn/start", (p) => (p as { session?: string }).session === spawned.sessionId);
    expect(childTurn.agentName).toBe(spawned.agentId);
    // ④ 周期终结推送
    const finishedFrame = await waitEvent(w.captured.lines, "agent/finished", (p) => (p as { agentId?: string }).agentId === spawned.agentId);
    const finished = finishedFrame.payload as { outcome: string; detail: string; summary?: string };
    expect(finished.outcome).toBe("completed");
    expect(finished.detail).toBe("completed");
    expect(finished.summary).toContain("child works");
    await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p1");
  });

  test("thread/stop 拆除序：子在飞时 stop → agent/finished{stopped} 帧可达（桥先于 teardown 拆）", async () => {
    const w = await spawn([
      { toolCalls: [{ name: "agent_spawn", input: '{"description":"slow","prompt":"work"}' }] },
      { reply: "parent continues" },
      { delayMs: 60_000 },
    ]);
    w.send({ type: "thread/start", id: "s1", permissionMode: "full" });
    const startedFrame = await waitResponse(w.captured.lines, "thread/start", "s1");
    const threadId = (startedFrame.data as { threadId: string }).threadId;
    w.send({ type: "prompt", id: "p1", threadId, message: "spawn slow one" });
    const spawnedFrame = await waitEvent(w.captured.lines, "agent/spawned");
    const spawned = spawnedFrame.payload as { agentId: string; sessionId: string };
    // 子消费 delay 剧本步（60s hold）——父继续收敛
    await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p1");
    w.send({ type: "thread/stop", id: "st1", threadId });
    await waitResponse(w.captured.lines, "thread/stop", "st1");
    // 拆除序承诺：stopAll 先于 unsubscribe——子的 finished 边沿必须到达客户端
    const finishedFrame = await waitEvent(w.captured.lines, "agent/finished", (p) => (p as { agentId?: string }).agentId === spawned.agentId);
    expect((finishedFrame.payload as { outcome: string }).outcome).toBe("stopped");
  });
});

describe("/compact 命令分路 e2e（BATCH3——方案 §5 承诺断言）", () => {
  test("成功三元组（compact 协议命令 + customInstructions 透传）", async () => {
    const huge = "h".repeat(60000);
    const w = await spawn([
      { reply: huge },
      { reply: huge },
      { reply: huge },
      { reply: huge },
      { reply: "SUM" }, // 摘要步
      { reply: "tail" },
    ]);
    const threadId = await start(w);
    for (const [index, tag] of ["one", "two", "three", "four"].entries()) {
      w.send({ type: "prompt", id: `base-${index}`, threadId, message: tag });
      await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === `base-${index}`);
    }
    w.send({ type: "compact", id: "ok-1", threadId, customInstructions: "focus tests" });
    const ok = await waitResponse(w.captured.lines, "compact", "ok-1");
    if (ok.success !== true) throw new Error(`compact failed: ${String(ok.error)}`);
    const data = ok.data as { summary: unknown; replacedCount: number; summaryTokens: number };
    expect(data.replacedCount).toBeGreaterThan(0);
    expect(data.summaryTokens).toBeGreaterThan(0);
    expect(JSON.stringify(data.summary)).toContain("SUM");
    // 命令生命周期事件可观察（log-only 配对）
    const lifecycle = w.captured.lines.filter((line) => /command\/(run|done)/.test(line));
    expect(lifecycle.length).toBeGreaterThanOrEqual(2);
  });

  test("双发第二响应 already in progress + abort 归一串 compaction aborted（prompt 拦截路径）", async () => {
    const huge = "h".repeat(60000);
    const w = await spawn([
      { reply: huge },
      { reply: huge },
      { reply: huge },
      { reply: huge },
      { delayMs: 60_000 }, // 摘要步挂起——abort 靶
      { reply: "tail" },
    ]);
    const threadId = await start(w);
    for (const [index, tag] of ["one", "two", "three", "four"].entries()) {
      w.send({ type: "prompt", id: `base-${index}`, threadId, message: tag });
      await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === `base-${index}`);
    }
    // /compact 经 prompt 拦截：摘要走 delay 步挂起（在飞）
    w.send({ type: "prompt", id: "cmd-1", threadId, message: "/compact keep goals" });
    w.send({ type: "compact", id: "dup-1", threadId });
    const dup = await waitResponse(w.captured.lines, "compact", "dup-1");
    expect(dup.error).toEqual({ code: "compact_rejected", message: "Compaction already in progress" });
    w.send({ type: "abort", id: "ab-1", threadId });
    await waitResponse(w.captured.lines, "abort", "ab-1");
    const aborted = await waitResponse(w.captured.lines, "prompt", "cmd-1");
    expect(aborted.error).toEqual({ code: "compact_rejected", message: "compaction aborted" });
  });
});

describe("get_token_analytics 旅程（外部插件消费面——docs/PLUGINS.md 契约 5）", () => {
  test("happy path：prompt 后实报数字在场（script usage 64/16+len）；12 字段 + sessionOutput", async () => {
    const w = await spawn([{ reply: "x" }]);
    const threadId = await start(w);
    w.send({ type: "prompt", id: "p1", threadId, message: "question" });
    await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p1");
    w.send({ type: "get_token_analytics", id: "ta1", threadId });
    const res = await waitResponse(w.captured.lines, "get_token_analytics", "ta1");
    expect(res.success).toBe(true);
    const data = res.data as { breakdown: Record<string, number>; sessionOutput: number };
    expect(Object.keys(data.breakdown).sort()).toEqual([
      "cacheHitRate", "contextWindow", "lastReportedInput", "messages", "remaining",
      "systemPrompt", "tools", "total", "totalCacheRead", "totalCacheWrite", "totalOutputTokens", "utilization",
    ]);
    expect(data.breakdown["lastReportedInput"]).toBe(64); // script adapter 实报
    expect(data.breakdown["totalOutputTokens"]).toBe(17); // 16 + "x".length
    expect(data.breakdown["contextWindow"]).toBe(200_000); // script adapter 申报
    // 实报优先律：total = 实报 input（分项估算偏大时 messages 归零，不再凑分项和）
    expect(data.breakdown["total"]).toBe(64);
    expect(data.breakdown["messages"]).toBe(0);
    expect(data.breakdown["remaining"]).toBe(200_000 - 64);
    expect(data.sessionOutput).toBe(17);
  });

  test("capability_plugin：plugins.disabled 禁用 → 线程在场而插件缺席", async () => {
    const w = await spawn([]);
    await writeFile(join(w.agentDir, "hub-settings.json"), JSON.stringify({ "plugins.disabled": ["token-analytics"] }));
    const threadId = await start(w);
    w.send({ type: "get_token_analytics", id: "ta1", threadId });
    const res = await waitResponse(w.captured.lines, "get_token_analytics", "ta1");
    expect(res.error).toEqual({ code: "capability_plugin", message: "token analytics plugin not loaded" });
  });

  test("unknown_thread 先行：无线程不被能力族劫持（自愈语义保真）", async () => {
    const w = await spawn([]);
    w.send({ type: "get_token_analytics", id: "ta1", threadId: "no-such-thread" });
    const res = await waitResponse(w.captured.lines, "get_token_analytics", "ta1");
    expect(res.error).toEqual({ code: "unknown_thread", message: "Unknown threadId" });
  });

  test("resume 统计域=装配后事件（固化现状：不含历史 usage）", async () => {
    const w = await spawn([{ reply: "x" }]);
    const threadId = await start(w);
    w.send({ type: "prompt", id: "p1", threadId, message: "question" });
    await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p1");
    const sessionPath = join(w.sessionsRoot, threadId, "events.jsonl");
    w.send({ type: "thread/stop", id: "sp1", threadId });
    await waitResponse(w.captured.lines, "thread/stop", "sp1");
    w.send({ type: "thread/resume", id: "r1", sessionPath });
    const resumed = await waitResponse(w.captured.lines, "thread/resume", "r1");
    expect(resumed.success).toBe(true);
    const newId = (resumed.data as { threadId: string }).threadId;
    w.send({ type: "get_token_analytics", id: "ta1", threadId: newId });
    const res = await waitResponse(w.captured.lines, "get_token_analytics", "ta1");
    const data = res.data as { breakdown: Record<string, number> };
    expect(data.breakdown["lastReportedInput"]).toBe(0); // 历史不重放
    expect(data.breakdown["totalOutputTokens"]).toBe(0);
  });
});
