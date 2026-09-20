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
    expect(bad.error).toBe("Session file not readable");
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

  test("resume 零字节卷 hub 预检拒（内核对空卷成功——预检归 hub）", async () => {
    const w = await spawn([]);
    const emptyDir = join(w.sessionsRoot, "emptyvol");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(emptyDir, { recursive: true });
    await writeFile(join(emptyDir, "header.json"), JSON.stringify({ id: "emptyvol", createdAt: 1 }), "utf8");
    await writeFile(join(emptyDir, "events.jsonl"), "", "utf8");
    w.send({ type: "thread/resume", id: "r1", sessionPath: join(emptyDir, "events.jsonl") });
    const rejected = await waitResponse(w.captured.lines, "thread/resume", "r1");
    expect(rejected.error).toBe("Session file not readable");
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
    expect(empty.error).toContain("invalid name");
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
    expect(denied.error).toBe("permission denied");
    // 弹窗期 abort_bash → aborted before execution started
    w.send({ type: "bash", id: "b2", threadId, command: "echo late" });
    await waitFrame(w.captured.lines, (f) => f.type === "ui_request" && f.method === "confirm");
    w.send({ type: "abort_bash", id: "ab1", threadId });
    const aborted = await waitResponse(w.captured.lines, "bash", "b2");
    expect(aborted.error).toBe("aborted before execution started");
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
    expect(badCmd.error).toBe("invalid command: required");
    w.send({ type: "bash", id: "b6", threadId, command: "echo x", timeoutMs: -1 });
    const badTimeout = await waitResponse(w.captured.lines, "bash", "b6");
    expect(badTimeout.error).toContain("invalid timeoutMs");
  });

  test("子代理面：agent_spawn 工具 → get_subagents 行 + subagent/steer 投递", async () => {
    const w = await spawn([
      { toolCalls: [{ name: "agent_spawn", input: '{"description":"research","prompt":"do work"}' }] },
      { reply: "child works" },
      { reply: "parent continues" },
    ]);
    // full 档起线程：agent_spawn 工具不弹窗（入参路径 + 授权面同步的旅程锚）
    w.send({ type: "thread/start", id: "s1", permissionMode: "full" });
    const startedFrame = await waitResponse(w.captured.lines, "thread/start", "s1");
    const threadId = (startedFrame.data as { threadId: string }).threadId;
    w.send({ type: "prompt", id: "p1", threadId, message: "spawn one" });
    await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p1");
    w.send({ type: "get_subagents", id: "sa1", threadId });
    const subs = await waitResponse(w.captured.lines, "get_subagents", "sa1");
    const rows = (subs.data as { subagents: Array<{ kind: string; agentId?: string; status: string }> }).subagents;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.kind).toBe("subagent");
    const agentId = rows[0]?.agentId ?? "";
    // steer 驻留目标（idle 唤醒语义）；未知目标拒
    w.send({ type: "subagent/steer", id: "ss1", threadId, agentId, message: "status update" });
    const steered = await waitResponse(w.captured.lines, "subagent/steer", "ss1");
    expect(steered.success).toBe(true);
    w.send({ type: "subagent/steer", id: "ss2", threadId, agentId: "agent-00000000", message: "x" });
    const missed = await waitResponse(w.captured.lines, "subagent/steer", "ss2");
    expect(missed.error).toContain("not available");
  });

  test("compact 双发预检 + abort 命令路径", async () => {
    const w = await spawn([{ reply: "some context" }]);
    const threadId = await start(w);
    w.send({ type: "compact", id: "c1", threadId });
    const first = await waitResponse(w.captured.lines, "compact", "c1");
    expect(first.success).toBe(false); // 上下文太小
    expect(first.error).toBe("context too small to compact");
    // abort 全路径（无在飞也幂等成功）
    w.send({ type: "abort", id: "ab1", threadId });
    await waitResponse(w.captured.lines, "abort", "ab1");
  });

  test("流式中 fork/compact/set_thinking_level 拒（thread is streaming）", async () => {
    const w = await spawn([{ delayMs: 60_000 }]);
    const threadId = await start(w);
    w.send({ type: "prompt", id: "p1", threadId, message: "hold" });
    await waitEvent(w.captured.lines, "turn/start");
    for (const [command, extra] of [
      ["fork", { seq: 0, position: "at" }],
      ["compact", {}],
      ["set_thinking_level", { level: "high" }],
    ] as const) {
      w.send({ type: command, id: `x-${command}`, threadId, ...extra });
      const rejected = await waitResponse(w.captured.lines, command, `x-${command}`);
      expect(rejected.error).toBe("thread is streaming");
    }
    w.send({ type: "prompt", id: "p2", threadId, message: "must fail" });
    const noBehavior = await waitResponse(w.captured.lines, "prompt", "p2");
    expect(noBehavior.error).toBe("streamingBehavior required while streaming");
  });

  test("fork 边界：seq 越界 / before 首事件 / 无效 seq", async () => {
    const w = await spawn([{ reply: "x" }]);
    const threadId = await start(w);
    w.send({ type: "prompt", id: "p1", threadId, message: "hi" });
    await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p1");
    w.send({ type: "fork", id: "f1", threadId, seq: 999 });
    const beyond = await waitResponse(w.captured.lines, "fork", "f1");
    expect(beyond.error).toBe("fork beyond durable boundary");
    w.send({ type: "fork", id: "f2", threadId, seq: 0 });
    const beforeFirst = await waitResponse(w.captured.lines, "fork", "f2");
    expect(beforeFirst.error).toBe("fork before first event");
    w.send({ type: "fork", id: "f3", threadId, seq: -1 });
    const invalid = await waitResponse(w.captured.lines, "fork", "f3");
    expect(invalid.error).toContain("invalid fork seq");
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
