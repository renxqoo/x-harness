// 事件桥单元（BATCH2 §3——D1/D2/D3 回归 + agentName 归属 + tool-stream 主/子分流）：
// 真 createContext + 合成事件/流派发，断言 wire 帧与观察态喂入——不依赖进程与竞态窗口。
import { describe, expect, test } from "vitest";
import { createContext } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { sessionDisposed, sessionEvent } from "@x-harness/session";
import type { SessionEvent } from "@x-harness/session";
import { agentAssistantStream, agentToolStream } from "@x-harness/agent-loop";
import { agentFinished, agentSpawned } from "@x-harness/agent-delegation";
import { llmStream } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { createEventBridge } from "../worker/event-bridge.ts";

interface Frame {
  type: string;
  name?: string;
  payload?: Record<string, unknown>;
  agentName?: string;
}

function makeBridge() {
  const frames: Frame[] = [];
  const inflightCalls: string[] = [];
  let partialSnapshot: unknown = null;
  const inflight = {
    turnStart: (seq: number, at: number) => inflightCalls.push(`turnStart:${seq}:${at}`),
    turnEnd: () => inflightCalls.push("turnEnd"),
    toolOutput: (callId: string, chunk: string) => inflightCalls.push(`toolOutput:${callId}:${chunk}`),
    toolDone: (callId: string) => inflightCalls.push(`toolDone:${callId}`),
    partial: (snapshot: unknown) => {
      partialSnapshot = snapshot;
    },
    snapshot: () => ({ turnStartSeq: null, turnStartedAt: null, message: null, toolOutputs: [] }),
  };
  const bridge = createEventBridge({
    emitLine: (line) => frames.push(JSON.parse(line) as Frame),
    threadId: () => "main-1",
    inflight: inflight as never,
  });
  return { bridge, frames, inflightCalls, readPartial: () => partialSnapshot };
}

function ev(seq: number, type: string, data: Record<string, unknown>): SessionEvent {
  return { type, seq, time: seq, data: data as never } as SessionEvent;
}

const MAIN = "main-1" as never;
const CHILD = "child-9" as never;

async function* chunksOf(list: readonly LlmChunk[]): AsyncGenerator<LlmChunk> {
  for (const chunk of list) yield chunk;
}

describe("事件桥归属（BATCH2 §3 D1/D2/D3 回归）", () => {
  async function wired(): Promise<{ ctx: Context; bridge: ReturnType<typeof createEventBridge> } & ReturnType<typeof makeBridge>> {
    const made = makeBridge();
    const ctx = createContext();
    made.bridge.wire(ctx);
    return { ctx, ...made };
  }

  test("D1：子会话 WAL 事件外发带 session 归属但不喂主线程状态；主会话照常喂", async () => {
    const w = await wired();
    w.ctx.emit(sessionEvent, { session: CHILD, event: ev(0, "turn/start", { turn: 5 }) });
    expect(w.inflightCalls).toEqual([]); // 子 turn 不翻转主 streaming/inflight
    const childFrame = w.frames.at(-1);
    expect(childFrame?.name).toBe("turn/start");
    expect(childFrame?.payload?.session).toBe("child-9");
    expect(childFrame?.payload?.turn).toBe(5);
    w.ctx.emit(sessionEvent, { session: MAIN, event: ev(0, "turn/start", { turn: 0 }) });
    expect(w.inflightCalls).toEqual(["turnStart:0:0"]);
    expect(w.frames.at(-1)?.payload?.session).toBe("main-1");
  });

  test("D2：子模型流不外发 llm/chunk、不喂 partial/游标；主会话流照常", async () => {
    const w = await wired();
    const childStream = await w.ctx.dispatch(llmStream, { model: "m", session: CHILD, tools: [], messages: [], signal: new AbortController().signal } as LlmRequest, async () => chunksOf([{ type: "text-delta", text: "child text" }]));
    for await (const _ of childStream) void _;
    expect(w.frames.filter((f) => f.name === "llm/chunk")).toEqual([]);
    const mainStream = await w.ctx.dispatch(llmStream, { model: "m", session: MAIN, tools: [], messages: [], signal: new AbortController().signal } as LlmRequest, async () => chunksOf([{ type: "text-delta", text: "main text" }]));
    for await (const _ of mainStream) void _;
    expect(w.frames.filter((f) => f.name === "llm/chunk")).toHaveLength(1);
  });

  test("D3：partial 文本唯一源 = assistant-stream 帧——tap 的 text-delta 不再双计", async () => {
    const w = await wired();
    w.ctx.emit(agentAssistantStream, { session: MAIN, turn: 1, step: 0, frame: { phase: "chunk", kind: "text", text: "abc" } });
    expect(w.readPartial()).toMatchObject({ role: "assistant", content: [{ type: "text", text: "abc" }] });
    // 同文本经 llm/chunk tap 再流一遍——partial 不得翻倍（回归：正文曾双计）
    const stream = await w.ctx.dispatch(llmStream, { model: "m", session: MAIN, tools: [], messages: [], signal: new AbortController().signal } as LlmRequest, async () => chunksOf([{ type: "text-delta", text: "abc" }]));
    for await (const _ of stream) void _;
    expect(w.readPartial()).toMatchObject({ role: "assistant", content: [{ type: "text", text: "abc" }] });
    // tap 仍喂 tool-call 增量（工具入参拼接面保留）
    const toolStream = await w.ctx.dispatch(llmStream, { model: "m", session: MAIN, tools: [], messages: [], signal: new AbortController().signal } as LlmRequest, async () => chunksOf([{ type: "tool-call-delta", index: 0, argumentsDelta: '{"a":' }]));
    for await (const _ of toolStream) void _;
    expect(w.readPartial()).toMatchObject({ role: "assistant", content: [{ type: "text", text: "abc" }, { type: "tool_use_partial", text: '{"a":' }] });
  });

  test("agentName：spawned 播种 → 子归属帧携带；sessionDisposed 清映射", async () => {
    const w = await wired();
    w.ctx.emit(agentSpawned, { parent: MAIN, agentId: "agent-abc12345", sessionId: CHILD, type: "explore", depth: 1 });
    expect(w.frames.at(-1)?.name).toBe("agent/spawned");
    w.ctx.emit(sessionEvent, { session: CHILD, event: ev(1, "assistant/message", { turn: 0, step: 0, content: [] }) });
    expect(w.frames.at(-1)?.agentName).toBe("agent-abc12345");
    w.ctx.emit(sessionEvent, { session: MAIN, event: ev(2, "assistant/message", { turn: 0, step: 0, content: [] }) });
    expect(w.frames.at(-1)?.agentName).toBeUndefined(); // 主会话帧不带
    w.ctx.emit(sessionDisposed, { session: CHILD });
    w.ctx.emit(sessionEvent, { session: CHILD, event: ev(3, "assistant/message", { turn: 0, step: 0, content: [] }) });
    expect(w.frames.at(-1)?.agentName).toBeUndefined(); // 已清
  });

  test("tool-stream 分流：主会话喂 inflight + 帧；子会话仅帧（带归属）+ 结算/轮界冲净不丢弃", async () => {
    const w = await wired();
    w.ctx.emit(agentSpawned, { parent: MAIN, agentId: "agent-abc12345", sessionId: CHILD, type: "explore", depth: 1 });
    w.ctx.emit(agentToolStream, { session: MAIN, callId: "c1", delta: "main-delta" });
    w.ctx.emit(agentToolStream, { session: CHILD, callId: "c1", delta: "child-delta" });
    expect(w.inflightCalls).toEqual(["toolOutput:c1:main-delta"]); // 子增量不进主 inflight
    // 结算边沿（主 tool/result）：立即冲净（不等 25ms 定时器）
    w.ctx.emit(sessionEvent, { session: MAIN, event: ev(1, "tool/result", { turn: 0, step: 0, callId: "c1", content: "done" }) });
    const mainFrames = w.frames.filter((f) => f.name === "agent/tool-stream");
    expect(mainFrames).toHaveLength(1);
    expect(mainFrames[0]?.payload).toMatchObject({ session: "main-1", callId: "c1", delta: "main-delta" });
    // 主轮边界不冲子的 pending（子后台跨父轮运行——收口审 K-H1 回归）
    w.ctx.emit(sessionEvent, { session: MAIN, event: ev(2, "turn/end", { turn: 0, reason: { kind: "completed" } }) });
    expect(w.frames.filter((f) => f.name === "agent/tool-stream").some((f) => (f.payload as { session?: string }).session === "child-9")).toBe(false);
    // 子 tool/result 结算：尾批冲净 + entry 撤（25ms 窗内两 delta 连接合并——无损）
    w.ctx.emit(agentToolStream, { session: CHILD, callId: "c1", delta: "child-delta-2" });
    w.ctx.emit(sessionEvent, { session: CHILD, event: ev(3, "tool/result", { turn: 0, step: 0, callId: "c1", content: "done" }) });
    const childFrames = w.frames.filter((f) => f.name === "agent/tool-stream" && (f.payload as { session?: string }).session === "child-9");
    expect(childFrames).toHaveLength(1);
    expect(childFrames[0]?.payload).toMatchObject({ callId: "c1", delta: "child-deltachild-delta-2" });
    expect(childFrames[0]?.agentName).toBe("agent-abc12345");
    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    }); // 结算后无残留发射
    expect(w.frames.filter((f) => f.name === "agent/tool-stream").length).toBe(2);
  });

  test("子轮边界冲净本会话在途增量（跨父轮运行常态）；sessionDisposed 兜底清", async () => {
    const w = await wired();
    w.ctx.emit(agentToolStream, { session: CHILD, callId: "c2", delta: "tail" });
    w.ctx.emit(sessionEvent, { session: CHILD, event: ev(0, "turn/start", { turn: 0 }) });
    w.ctx.emit(sessionEvent, { session: CHILD, event: ev(1, "turn/end", { turn: 0, reason: { kind: "completed" } }) });
    const frames = w.frames.filter((f) => f.name === "agent/tool-stream");
    expect(frames).toHaveLength(1); // 轮边界冲净（不丢弃）
    expect(frames[0]?.payload).toMatchObject({ session: "child-9", callId: "c2", delta: "tail" });
    // sessionDisposed 兜底：新 pending 在无结算边沿时随会话终结冲净
    w.ctx.emit(agentToolStream, { session: CHILD, callId: "c3", delta: "last" });
    w.ctx.emit(sessionDisposed, { session: CHILD });
    expect(w.frames.filter((f) => f.name === "agent/tool-stream").some((f) => (f.payload as { callId?: string }).callId === "c3")).toBe(true);
  });

  test("agent/finished 原样转发（周期终结边沿）", async () => {
    const w = await wired();
    w.ctx.emit(agentFinished, { parent: MAIN, agentId: "agent-abc12345", sessionId: CHILD, outcome: "completed", detail: "completed", summary: "did things" });
    const frame = w.frames.at(-1);
    expect(frame?.name).toBe("agent/finished");
    expect(frame?.payload).toMatchObject({ outcome: "completed", detail: "completed", summary: "did things" });
  });
});

async function wiredBridge(): Promise<{ ctx: Context; bridge: ReturnType<typeof createEventBridge> }> {
  const made = makeBridge();
  const ctx = createContext();
  made.bridge.wire(ctx);
  return { ctx, bridge: made.bridge };
}

describe("命令执行中计数（BATCH3 §2.4——busy 面/清账面）", () => {
  test("主会话 run/done 边沿计数；子会话不计；unsubscribe 清零", async () => {
    const w = await wiredBridge();
    expect(w.bridge.commandBusy()).toBe(false);
    w.ctx.emit(sessionEvent, { session: CHILD, event: ev(0, "command/run", { commandId: "c-x", name: "compact" }) });
    expect(w.bridge.commandBusy()).toBe(false); // 子会话不计
    w.ctx.emit(sessionEvent, { session: MAIN, event: ev(1, "command/run", { commandId: "c1", name: "compact" }) });
    w.ctx.emit(sessionEvent, { session: MAIN, event: ev(2, "command/run", { commandId: "c2", name: "compact" }) });
    expect(w.bridge.commandBusy()).toBe(true);
    w.ctx.emit(sessionEvent, { session: MAIN, event: ev(3, "command/done", { commandId: "c1", kind: "success" }) });
    expect(w.bridge.commandBusy()).toBe(true); // c2 仍在飞
    w.ctx.emit(sessionEvent, { session: MAIN, event: ev(4, "command/done", { commandId: "c2", kind: "error", text: "x" }) });
    expect(w.bridge.commandBusy()).toBe(false);
    w.ctx.emit(sessionEvent, { session: MAIN, event: ev(5, "command/run", { commandId: "c3", name: "compact" }) });
    expect(w.bridge.commandBusy()).toBe(true);
    w.bridge.unsubscribe(); // fork 重装配清账
    expect(w.bridge.commandBusy()).toBe(false);
  });
});
