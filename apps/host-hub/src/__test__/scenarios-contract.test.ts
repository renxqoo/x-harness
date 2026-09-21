// 场景 e2e：契约旅程（MIGRATION §5 scenarios-contract 对应行）——收敛读重连合并
// （get_entries{since} + get_inflight 幂等）、bash 直执行全旅程（流式事件/信封/
// abort_bash）、/compact 拦截、子代理面（真进程 spawn→get_subagents→steer）。
import { afterAll, describe, expect, test } from "vitest";
import { drivePrompt, startHost } from "./kit/host-client.ts";
import type { HostHandle } from "./kit/host-client.ts";

const hosts: HostHandle[] = [];
afterAll(async () => {
  for (const host of hosts) host.end();
  await Promise.all(hosts.map((host) => host.exited().catch(() => -1)));
});

describe("场景：契约", () => {
  test("收敛读：多轮 get_entries since 游标增量 + get_inflight 幂等合并", async () => {
    const host = await startHost({ script: [{ reply: "turn one" }, { reply: "turn two" }] });
    hosts.push(host);
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir });
    const started = await host.response("s1");
    const threadId = (started.data as { threadId: string }).threadId;
    await drivePrompt(host, { threadId, id: "p1", message: "first" });
    // 全量 → leafSeq；since 增量
    host.send({ type: "get_entries", id: "e0", threadId });
    const full = (await host.response("e0")).data as { entries: Array<{ seq: number }>; leafSeq: number; hasMore: boolean };
    const firstLeaf = full.leafSeq;
    await drivePrompt(host, { threadId, id: "p2", message: "second" });
    host.send({ type: "get_entries", id: "e1", threadId, since: firstLeaf });
    const delta = (await host.response("e1")).data as { entries: Array<{ seq: number }>; leafSeq: number };
    expect(delta.entries.length).toBeGreaterThan(0);
    expect(delta.entries[0]?.seq).toBe(firstLeaf + 1); // since 排他（游标后第一条）
    // 重连水化配方：get_entries{since} + get_inflight 并行拉取幂等（两次同游标结果一致）
    host.send({ type: "get_entries", id: "e2", threadId, since: firstLeaf });
    const delta2 = (await host.response("e2")).data as { entries: Array<{ seq: number }> };
    expect(delta2.entries.map((e) => e.seq)).toEqual(delta.entries.map((e) => e.seq));
    host.send({ type: "get_inflight", id: "i1", threadId });
    const inflight = await host.response("i1");
    expect(inflight.data).toEqual({ turnStartSeq: null, turnStartedAt: null, message: null, toolOutputs: [], bash: null });
  }, 90_000);

  test("bash 直执行全旅程：流式 bash_execution_update + 信封 WAL + abort_bash 弹窗期", async () => {
    const host = await startHost({ script: [{ reply: "x" }] });
    hosts.push(host);
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir });
    const started = await host.response("s1");
    const threadId = (started.data as { threadId: string }).threadId;
    await drivePrompt(host, { threadId, id: "p1", message: "hi" });
    // 弹窗期 abort_bash
    host.send({ type: "bash", id: "b0", threadId, command: "echo late" });
    const req0 = await host.wait((frame) => frame.type === "ui_request" && frame.method === "confirm" && frame.summary === "echo late", "bash confirm 0");
    host.send({ type: "abort_bash", id: "ab0", threadId });
    const aborted = await host.response("b0");
    expect(aborted.error).toEqual({ code: "bash_denied", message: "aborted before execution started" });
    await host.response("ab0");
    void req0;
    // 正常执行：确认 → 流式 → 完成 → 信封
    host.send({ type: "bash", id: "b1", threadId, command: "echo journey-output" });
    await host.wait((frame) => frame.type === "ui_request" && frame.method === "confirm" && frame.summary === "echo journey-output", "bash confirm 1");
    const req1 = host.lines.find((frame) => frame.type === "ui_request" && (frame as { summary?: string }).summary === "echo journey-output");
    host.send({ type: "ui_response", id: "ur1", requestId: (req1 as unknown as { requestId: string }).requestId, payload: { confirmed: true } });
    const done = await host.response("b1");
    const data = done.data as { output: string; exitCode: number; cancelled: boolean };
    expect(data.exitCode).toBe(0);
    expect(data.output).toContain("journey-output");
    // 信封落 WAL（get_entries 尾部可见 [bash] 前缀）
    host.send({ type: "get_entries", id: "e1", threadId, limit: 3 });
    const entries = (await host.response("e1")).data as { entries: Array<{ event: { type: string; content?: Array<{ text?: string }> } }> };
    const envelope = entries.entries.find((entry) => entry.event.type === "user/message" && JSON.stringify(entry.event.content).includes("[bash] $"));
    expect(envelope).toBeDefined();
    // 执行期 abort_bash（带 id 定向）
    host.send({ type: "bash", id: "b2", threadId, command: "sleep 5" });
    await host.wait((frame) => frame.type === "ui_request" && (frame as { summary?: string }).summary === "sleep 5", "bash confirm 2");
    const req2 = host.lines.filter((frame) => frame.type === "ui_request").at(-1);
    host.send({ type: "ui_response", id: "ur2", requestId: (req2 as unknown as { requestId: string }).requestId, payload: { confirmed: true } });
    // abort_bash 的定向 id 与命令关联 id 同键（协议设计：定向键即 id）——ack 与 bash
    // 终态两帧同 id，取「带 cancelled 数据」的那帧
    host.send({ type: "abort_bash", id: "b2", threadId });
    const cancelledFrame = await host.wait((frame) => frame.type === "response" && frame.command === "bash" && frame.id === "b2" && (frame.data as { cancelled?: boolean } | undefined)?.cancelled === true, "bash b2 cancelled");
    expect(cancelledFrame).toBeDefined();
  }, 90_000);

  test("/compact 拦截：命令 id 回显 command 留 prompt、完成才回（上下文太小 → 归一文案）", async () => {
    const host = await startHost({ script: [{ reply: "tiny" }] });
    hosts.push(host);
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir });
    const started = await host.response("s1");
    const threadId = (started.data as { threadId: string }).threadId;
    await drivePrompt(host, { threadId, id: "p1", message: "hi" });
    host.send({ type: "prompt", id: "c1", threadId, message: "/compact keep the goals" });
    const compacted = await host.response("c1");
    expect(compacted.command).toBe("prompt"); // 响应 command 留 prompt
    expect(compacted.error).toEqual({ code: "compact_rejected", message: "context too small to compact" });
  }, 60_000);

  test("子代理面：agent_spawn（full 档）→ get_subagents 行 → subagent/steer 投递", async () => {
    const host = await startHost({ script: [
      { toolCalls: [{ name: "agent_spawn", input: '{"description":"probe","prompt":"work"}' }] },
      { reply: "spawned and waiting" },
    ] });
    hosts.push(host);
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir, permissionMode: "full" });
    const started = await host.response("s1");
    const threadId = (started.data as { threadId: string }).threadId;
    host.send({ type: "prompt", id: "p1", threadId, message: "spawn one" });
    await host.response("p1");
    await host.event("settled", (payload) => (payload as { sendId?: string }).sendId === "p1", 30_000);
    host.send({ type: "get_subagents", id: "sa1", threadId });
    const subs = (await host.response("sa1")).data as { subagents: Array<{ kind: string; agentId?: string; status: string }> };
    expect(subs.subagents.length).toBeGreaterThanOrEqual(1);
    const agentId = subs.subagents[0]?.agentId ?? "";
    expect(agentId).toMatch(/^agent-/);
    host.send({ type: "subagent/steer", id: "ss1", threadId, agentId, message: "status?" });
    const steered = await host.response("ss1");
    expect(steered.success).toBe(true);
    host.send({ type: "subagent/steer", id: "ss2", threadId, agentId: "agent-00000000", message: "x" });
    const miss = await host.response("ss2");
    const missErr = miss.error as { code?: string; message?: string } | undefined;
    expect(missErr?.code).toBe("invalid_input");
    expect(missErr?.message).toContain("not available");
  }, 90_000);
});
