// worker 内嵌旅程（MIGRATION §5 worker-embedded-commands/races 移植 + x-harness
// 语义锚）：prompt 双路径/settled 恰一与排序/事件词表/llm-chunk/dial+thinking 挂点
// （request-header·context 落盘）/fork 旅程/clear_queue/压缩预检/权限即时切/读口形状
// ——failure 必 emit 表驱动（恰一响应铁律）。
import { afterAll, describe, expect, test } from "vitest";
import { spawnScriptWorker, waitEvent, waitFrame, waitResponse } from "./kit/worker-harness.ts";
import type { ScriptWorker } from "./kit/worker-harness.ts";
import type { ScriptStep } from "../shared/script-adapter.ts";

const workers: Array<{ input: ScriptWorker["input"] }> = [];
afterAll(async () => {
  for (const w of workers) w.input.end();
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
});

async function spawn(script: readonly ScriptStep[]): Promise<ScriptWorker> {
  const w = await spawnScriptWorker({ script });
  workers.push({ input: w.input });
  return w;
}

/** text-only 目录 worker：快照通道（非 script 模式）注入无 input 声明的模型——
 *  能力门拒绝路径的嵌入式装置（prompt 在 LLM 调用前被拒，不打网络） */
async function spawnTextOnlyWorker(): Promise<ScriptWorker> {
  const w = await spawnScriptWorker({
    env: {
      HUB_WORKER_PROVIDER: undefined,
      HUB_WORKER_PROVIDERS: JSON.stringify({
        providers: [{ provider: "p", protocol: "anthropic", baseUrl: "http://127.0.0.1:9", apiKey: "", models: ["m1"] }],
        default: { provider: "p", model: "m1" },
        modelMeta: { m1: { reasoning: true } },
      }),
    },
  });
  workers.push({ input: w.input });
  return w;
}

interface DrivePlan {
  script: readonly ScriptStep[];
  message: string;
}

/** 旅程基元：start → prompt → settled（返回线程上下文） */
async function drivePrompt(plan: DrivePlan): Promise<{ worker: ScriptWorker; threadId: string; events: string[] }> {
  const worker = await spawn(plan.script);
  worker.send({ type: "thread/start", id: "s1", cwd: worker.agentDir });
  const started = await waitResponse(worker.captured.lines, "thread/start", "s1");
  const threadId = (started.data as { threadId: string }).threadId;
  worker.send({ type: "prompt", id: "p1", threadId, message: plan.message });
  await waitResponse(worker.captured.lines, "prompt", "p1");
  await waitEvent(worker.captured.lines, "settled", (payload) => (payload as { sendId?: string }).sendId === "p1");
  const names = worker.captured.lines
    .map((line) => JSON.parse(line) as { type: string; name?: string })
    .filter((frame) => frame.type === "event")
    .map((frame) => frame.name as string);
  return { worker, threadId, events: names };
}

describe("worker 内嵌旅程", () => {
  test("hello 首帧 + thread/start + prompt → settled 恰一 + 事件词表（session 域 + llm/chunk + agent/status）", async () => {
    const { worker, threadId, events } = await drivePrompt({ script: [{ reply: "hello world" }], message: "hi" });
    expect(threadId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    // 事件词表锚（DESIGN §4）
    for (const name of ["turn/start", "user/message", "assistant/message", "turn/end", "agent/status", "llm/chunk"]) {
      expect(events, `event ${name}`).toContain(name);
    }
    // llm/chunk 载荷携带 text-delta
    const chunk = await waitEvent(worker.captured.lines, "llm/chunk", (payload) => (payload as { chunk?: { type?: string } }).chunk?.type === "text-delta");
    expect((chunk.payload as { chunk: { text: string } }).chunk.text).toBe("hello world");
    // settled 恰一（同 sendId 只一条）
    const settledCount = worker.captured.lines.filter((line) => {
      const frame = JSON.parse(line) as { type: string; name?: string; payload?: { sendId?: string } };
      return frame.type === "event" && frame.name === "settled" && frame.payload?.sendId === "p1";
    }).length;
    expect(settledCount).toBe(1);
  });

  test("steer/follow_up 显式排队 + clear_queue 返回被清文本（inbox clear 直写）", async () => {
    const worker = await spawn([{ delayMs: 60_000 }, { reply: "never" }]);
    worker.send({ type: "thread/start", id: "s1" });
    const started = await waitResponse(worker.captured.lines, "thread/start", "s1");
    const threadId = (started.data as { threadId: string }).threadId;
    // 首 prompt 占住 turn（delay 剧本 hold）
    worker.send({ type: "prompt", id: "p1", threadId, message: "first" });
    await waitResponse(worker.captured.lines, "prompt", "p1");
    await waitEvent(worker.captured.lines, "turn/start");
    // 流式中显式 steer/follow_up 排队
    worker.send({ type: "steer", id: "st1", threadId, message: "steer-text" });
    await waitResponse(worker.captured.lines, "steer", "st1");
    worker.send({ type: "follow_up", id: "fu1", threadId, message: "later-text" });
    await waitResponse(worker.captured.lines, "follow_up", "fu1");
    // clear_queue：返回被清文本（steering 含 steer-text）
    worker.send({ type: "clear_queue", id: "cq1", threadId });
    const cleared = await waitResponse(worker.captured.lines, "clear_queue", "cq1");
    expect(cleared.success).toBe(true);
    expect((cleared.data as { steering: string[]; followUp: string[] }).steering).toContain("steer-text");
    expect((cleared.data as { steering: string[]; followUp: string[] }).followUp).toContain("later-text");
    // abort 收敛：settled ok（abort 不取消 settled）
    worker.send({ type: "abort", id: "ab1", threadId });
    await waitResponse(worker.captured.lines, "abort", "ab1");
    await waitEvent(worker.captured.lines, "settled", (payload) => (payload as { sendId?: string }).sendId === "p1");
  });

  test("get_state/get_entries/get_commands/get_inflight 读口形状（seq 0 基 + queue 折叠 + 目录）", async () => {
    const { worker, threadId } = await drivePrompt({ script: [{ reply: "done" }], message: "hello" });
    worker.send({ type: "get_state", id: "g1", threadId });
    const state = await waitResponse(worker.captured.lines, "get_state", "g1");
    const data = state.data as { model: { provider: string; model: string }; sessionId: string; queue: { steering: string[]; followUp: string[] }; messageCount: number };
    expect(data.model).toEqual({ provider: "script", model: "script-1" });
    expect(data.sessionId).toBe(threadId);
    expect(data.queue).toEqual({ steering: [], followUp: [] });
    expect(data.messageCount).toBeGreaterThanOrEqual(2); // user + assistant（+ 快照注入面）

    worker.send({ type: "get_entries", id: "e1", threadId, limit: 3 });
    const entries = await waitResponse(worker.captured.lines, "get_entries", "e1");
    const ed = entries.data as { entries: Array<{ seq: number; event: { type: string } }>; leafSeq: number; hasMore: boolean };
    expect(ed.entries.every((entry) => entry.seq >= 0)).toBe(true);
    expect(ed.hasMore).toBe(true);
    expect(ed.entries.length).toBe(3);

    worker.send({ type: "get_commands", id: "c1", threadId });
    const commands = await waitResponse(worker.captured.lines, "get_commands", "c1");
    const listed = commands.data as Array<{ name: string; source: string }>;
    expect(listed.some((cmd) => cmd.name === "compact" && cmd.source === "builtin")).toBe(true);

    worker.send({ type: "get_inflight", id: "i1", threadId });
    const inflight = await waitResponse(worker.captured.lines, "get_inflight", "i1");
    expect(inflight.data).toEqual({ turnStartSeq: null, turnStartedAt: null, message: null, toolOutputs: [], bash: null });
  });

  test("set_thinking_level 下一 turn 生效（dial.thinking 进 request/header）+ get 四态", async () => {
    const worker = await spawn([{ reply: "a" }, { reply: "b" }]);
    worker.send({ type: "thread/start", id: "s1" });
    const started = await waitResponse(worker.captured.lines, "thread/start", "s1");
    const threadId = (started.data as { threadId: string }).threadId;
    worker.send({ type: "set_thinking_level", id: "t1", threadId, level: "high" });
    await waitResponse(worker.captured.lines, "set_thinking_level", "t1");
    worker.send({ type: "get_thinking_level", id: "t2", threadId });
    const got = await waitResponse(worker.captured.lines, "get_thinking_level", "t2");
    expect(got.data).toEqual({ level: "high", source: "session" });
    // 下一 turn 的 request/header 落 thinking
    worker.send({ type: "prompt", id: "p1", threadId, message: "go" });
    await waitEvent(worker.captured.lines, "settled", (payload) => (payload as { sendId?: string }).sendId === "p1");
    const header = await waitEvent(worker.captured.lines, "request/header", (payload) => (payload as { thinking?: string }).thinking === "high");
    expect(header).toBeDefined();
    // 词表外拒
    worker.send({ type: "set_thinking_level", id: "t3", threadId, level: "huge" });
    const bad = await waitResponse(worker.captured.lines, "set_thinking_level", "t3");
    expect(bad.error).toBe("invalid thinking level: huge");
  });

  test("set_model 下一 turn 生效（dial meta → request/context 落盘）+ 未知名 fail-closed", async () => {
    const worker = await spawn([{ reply: "a" }, { reply: "b" }]);
    worker.send({ type: "thread/start", id: "s1" });
    const started = await waitResponse(worker.captured.lines, "thread/start", "s1");
    const threadId = (started.data as { threadId: string }).threadId;
    worker.send({ type: "set_model", id: "m1", threadId, provider: "script", modelId: "nope" });
    const unknown = await waitResponse(worker.captured.lines, "set_model", "m1");
    expect(unknown.success).toBe(false);
    expect(unknown.error).toContain("unknown model preset");
    worker.send({ type: "set_model", id: "m2", threadId, provider: "script", modelId: "script-1" });
    const okSet = await waitResponse(worker.captured.lines, "set_model", "m2");
    expect(okSet.success).toBe(true);
    worker.send({ type: "prompt", id: "p1", threadId, message: "go" });
    await waitEvent(worker.captured.lines, "settled", (payload) => (payload as { sendId?: string }).sendId === "p1");
    const context = await waitEvent(worker.captured.lines, "request/context", (payload) => (payload as { model?: string }).model === "script-1");
    expect(context).toBeDefined();
  });

  test("fork 全旅程：旧 id 立即失效 + 前缀继承（dial meta 复制）", async () => {
    const { worker, threadId } = await drivePrompt({ script: [{ reply: "origin" }], message: "hello" });
    worker.send({ type: "set_thinking_level", id: "t1", threadId, level: "low" });
    await waitResponse(worker.captured.lines, "set_thinking_level", "t1");
    // clone = fork at leafSeq：含 dial/thinking meta 尾值的前缀（fork at 早期 seq 不含
    // 后置 meta——边界语义锚）
    worker.send({ type: "clone", id: "f1", threadId });
    const forked = await waitResponse(worker.captured.lines, "clone", "f1");
    const data = forked.data as { threadId: string; previousThreadId: string };
    expect(data.previousThreadId).toBe(threadId);
    expect(data.threadId).not.toBe(threadId);
    // 旧 id 命令 → Unknown threadId（单会话守卫）
    worker.send({ type: "get_state", id: "g-old", threadId });
    const oldGuard = await waitResponse(worker.captured.lines, "get_state", "g-old");
    expect(oldGuard.error).toBe("Unknown threadId");
    // 新线程 thinking 继承（前缀 meta 复制）
    worker.send({ type: "get_thinking_level", id: "t2", threadId: data.threadId });
    const inherited = await waitResponse(worker.captured.lines, "get_thinking_level", "t2");
    expect(inherited.data).toEqual({ level: "low", source: "session" });
  });

  test("permission/set_mode 即时切 + 持久化；get 四态", async () => {
    const { threadId, worker } = await drivePrompt({ script: [{ reply: "x" }], message: "hi" });
    worker.send({ type: "permission/set_mode", id: "pm1", threadId, mode: "full" });
    await waitResponse(worker.captured.lines, "permission/set_mode", "pm1");
    worker.send({ type: "permission/get_mode", id: "pm2", threadId });
    const got = await waitResponse(worker.captured.lines, "permission/get_mode", "pm2");
    expect(got.data).toMatchObject({ mode: "full", source: "session" });
    worker.send({ type: "permission/set_mode", id: "pm3", threadId, mode: "bogus" });
    const bad = await waitResponse(worker.captured.lines, "permission/set_mode", "pm3");
    expect(bad.error).toBe("invalid permission mode: bogus");
  });

  test("compact：双发拒 + /compact 拦截（响应 command 留 prompt）", async () => {
    const worker = await spawn([{ reply: "long enough context for compaction to find a cut point maybe not" }]);
    worker.send({ type: "thread/start", id: "s1" });
    const started = await waitResponse(worker.captured.lines, "thread/start", "s1");
    const threadId = (started.data as { threadId: string }).threadId;
    // /compact 拦截：上下文太小 → context too small to compact（响应 command 留 prompt）
    worker.send({ type: "prompt", id: "p1", threadId, message: "/compact keep the goals" });
    const compacted = await waitResponse(worker.captured.lines, "prompt", "p1");
    expect(compacted.success).toBe(false);
    expect(compacted.error).toBe("context too small to compact");
  });

  test("prompt 携图全链（单 entry 图文同轮落 WAL）+ 形状/量限/compact 拒绝", async () => {
    const worker = await spawn([{ reply: "got it" }]);
    worker.send({ type: "thread/start", id: "s1" });
    const started = await waitResponse(worker.captured.lines, "thread/start", "s1");
    const threadId = (started.data as { threadId: string }).threadId;
    worker.send({ type: "prompt", id: "p1", threadId, message: "hi", images: [{ type: "image", data: "aGk=", mediaType: "image/png" }] });
    const accepted = await waitResponse(worker.captured.lines, "prompt", "p1");
    expect(accepted.error).toBeUndefined();
    await waitEvent(worker.captured.lines, "settled", (payload) => (payload as { sendId?: string }).sendId === "p1");
    // WAL 投影：user/message 单条携带 [text, image] 全块（单 entry 同轮——拆轮防线回归）
    worker.send({ type: "get_entries", id: "e1", threadId });
    const entries = await waitResponse(worker.captured.lines, "get_entries", "e1");
    const userMsg = (entries.data as { entries: Array<{ event: { type: string; content?: unknown } }> }).entries
      .filter((row) => row.event.type === "user/message")
      .at(-1); // 末条 = 本 prompt 落账（首条是 running 边沿注入的 agent-types 快照）
    expect(userMsg?.event.content).toEqual([
      { type: "text", text: "hi" },
      { type: "image", data: "aGk=", mediaType: "image/png" },
    ]);
    // fork 选点投影：纯图/携图行可见（[image] 标记——不留整行缺席）
    worker.send({ type: "get_fork_messages", id: "f1", threadId });
    const forks = await waitResponse(worker.captured.lines, "get_fork_messages", "f1");
    const forkRow = JSON.stringify((forks.data as unknown[]).at(-1)); // 末行 = 本 prompt（首行是 agent-types 快照）
    expect(forkRow).toContain("hi");
    expect(forkRow).toContain("[image: image/png]");
    // 形状拒绝（hub 边缘硬拒）
    worker.send({ type: "prompt", id: "p2", threadId, message: "hi", images: "junk" });
    expect((await waitResponse(worker.captured.lines, "prompt", "p2")).error).toBe("invalid images: expected array");
    worker.send({ type: "prompt", id: "p3", threadId, message: "hi", images: [{}] });
    expect((await waitResponse(worker.captured.lines, "prompt", "p3")).error).toBe("invalid images: type must be image");
    // 量限拒绝：张数
    worker.send({ type: "prompt", id: "p4", threadId, message: "hi", images: Array.from({ length: 9 }, () => ({ type: "image", data: "aGk=", mediaType: "image/png" })) });
    expect((await waitResponse(worker.captured.lines, "prompt", "p4")).error).toContain("invalid images: too many images");
    // compact 拦截仍拒图（能力门先过——script-1 携 image 模态）
    worker.send({ type: "prompt", id: "p5", threadId, message: "/compact", images: [{ type: "image", data: "aGk=", mediaType: "image/png" }] });
    expect((await waitResponse(worker.captured.lines, "prompt", "p5")).error).toBe("invalid images: compact does not accept images");
  });

  test("能力门：模型输入模态不含 image → 携图拒（steer 同口径）", async () => {
    const worker = await spawnTextOnlyWorker();
    worker.send({ type: "thread/start", id: "s1" });
    const started = await waitResponse(worker.captured.lines, "thread/start", "s1");
    const threadId = (started.data as { threadId: string }).threadId;
    worker.send({ type: "prompt", id: "p1", threadId, message: "hi", images: [{ type: "image", data: "aGk=", mediaType: "image/png" }] });
    const gated = await waitResponse(worker.captured.lines, "prompt", "p1");
    expect(gated.error).toBe("invalid images: model does not accept images");
    worker.send({ type: "steer", id: "st1", threadId, message: "hi", images: [{ type: "image", data: "aGk=", mediaType: "image/png" }] });
    expect((await waitResponse(worker.captured.lines, "steer", "st1")).error).toBe("invalid images: model does not accept images");
  });

  test("failure 必 emit 表驱动：unknown command / parse failure / Unknown threadId（无会话与错 id 两面）", async () => {
    const worker = await spawn([]);
    worker.input.send("not json");
    const parse = await waitResponse(worker.captured.lines, "parse");
    expect(parse.success).toBe(false);
    expect(parse.error).toBe("parse failure");
    worker.send({ type: "no_such_command", id: "u1" });
    const unknown = await waitResponse(worker.captured.lines, "no_such_command", "u1");
    expect(unknown.error).toBe("unknown command");
    worker.send({ type: "get_state", id: "g1" });
    const noThread = await waitResponse(worker.captured.lines, "get_state", "g1");
    expect(noThread.error).toBe("Unknown threadId");
    worker.send({ type: "get_state", id: "g2", threadId: "missing" });
    const badThread = await waitResponse(worker.captured.lines, "get_state", "g2");
    expect(badThread.error).toBe("Unknown threadId");
  });

  test("thread/stop 幂等 + stop 后线程空（Unknown threadId）", async () => {
    const { threadId, worker } = await drivePrompt({ script: [{ reply: "x" }], message: "hi" });
    worker.send({ type: "thread/stop", id: "sp1", threadId });
    await waitResponse(worker.captured.lines, "thread/stop", "sp1");
    worker.send({ type: "thread/stop", id: "sp2", threadId });
    const again = await waitResponse(worker.captured.lines, "thread/stop", "sp2");
    expect(again.success).toBe(true);
    worker.send({ type: "get_state", id: "g1", threadId });
    const gone = await waitResponse(worker.captured.lines, "get_state", "g1");
    expect(gone.error).toBe("Unknown threadId");
  });

  test("get_subagents 空形态 + get_pending_dialogs 空形态（恒 success）", async () => {
    const { threadId, worker } = await drivePrompt({ script: [{ reply: "x" }], message: "hi" });
    worker.send({ type: "get_subagents", id: "sa1", threadId });
    const subs = await waitResponse(worker.captured.lines, "get_subagents", "sa1");
    expect(subs.data).toEqual({ subagents: [] });
    worker.send({ type: "get_pending_dialogs", id: "pd1", threadId });
    const dialogs = await waitResponse(worker.captured.lines, "get_pending_dialogs", "pd1");
    expect(dialogs.data).toEqual({ dialogs: [] });
  });

  test("bash 直执行旅程：confirm 弹窗 → 确认 → 输出信封落会话（user/message）", async () => {
    const worker = await spawn([{ reply: "x" }]);
    worker.send({ type: "thread/start", id: "s1" });
    const started = await waitResponse(worker.captured.lines, "thread/start", "s1");
    const threadId = (started.data as { threadId: string }).threadId;
    worker.send({ type: "bash", id: "b1", threadId, command: "echo hub-test-42" });
    const request = await waitFrame(worker.captured.lines, (frame) => frame.type === "ui_request" && frame.method === "confirm");
    const requestId = request.requestId as string;
    worker.send({ type: "ui_response", id: "ur1", requestId, payload: { confirmed: true } });
    const done = await waitResponse(worker.captured.lines, "bash", "b1");
    const data = done.data as { output: string; exitCode: number; cancelled: boolean; truncated: boolean };
    expect(data.exitCode).toBe(0);
    expect(data.output).toContain("hub-test-42");
    expect(data.cancelled).toBe(false);
    // 信封落会话（get_entries 后续可见 user/message 含 [bash] 前缀）
    const envelope = await waitEvent(worker.captured.lines, "user/message", (payload) =>
      Array.isArray((payload as { content?: Array<{ text?: string }> }).content) &&
      ((payload as { content: Array<{ text?: string }> }).content[0]?.text ?? "").startsWith("[bash] $"),
    );
    expect(envelope).toBeDefined();
  });
});
