import type { Context } from "@x-harness/core";
import { sessionDisposed, sessionEvent } from "@x-harness/session";
import type { SessionEvent } from "@x-harness/session";
import { agentAssistantStream, agentError, agentStatus, agentToolStream } from "@x-harness/agent-loop";
import { agentFinished, agentSpawned } from "@x-harness/agent-delegation";
import { llmStream } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { compactionDiagnostic, compactionLanded, compactionServedWindow } from "@x-harness/compaction";
import { autocompactBreaker, autocompactCheckpoint, autocompactDiagnostic, autocompactL1Cleared, autocompactL2Escalated, autocompactLinesDegraded, autocompactParallelApproach } from "@x-harness/autocompact";
import { permissionDecided } from "@x-harness/permission";
import { checkpointDiagnostic } from "@x-harness/session-checkpoint";
import type { InflightState } from "./inflight.ts";
import { TOOL_STREAM_MIN_INTERVAL_MS } from "../shared/limits.ts";
import { eventFrame } from "../protocol/frames.ts";

export interface EventBridgeDeps {
  emitLine: (line: string) => void;
  threadId: () => string;
  inflight: InflightState;
  pendingSends: () => number;
  mainEvents: () => readonly SessionEvent[] | undefined;
}

function createPartialAccumulator() {
  let text = "";
  let thinking = "";
  let toolInput = "";
  return {
    pushChunk(kind: "text" | "thinking", value: string): void {
      if (kind === "text") text += value;
      else thinking += value;
    },
    pushToolDelta(delta: string): void {
      toolInput += delta;
    },
    reset(): void {
      text = "";
      thinking = "";
      toolInput = "";
    },
    snapshot(): unknown {
      if (text === "" && thinking === "" && toolInput === "") return null;
      const content: Array<{ type: string; text?: string }> = [];
      if (thinking !== "") content.push({ type: "thinking", text: thinking });
      if (text !== "") content.push({ type: "text", text });
      if (toolInput !== "") content.push({ type: "tool_use_partial", text: toolInput });
      return { role: "assistant", content };
    },
  };
}

export interface EventBridge {
  wire(ctx: Context): void;
  unsubscribe(): void;
  emitSettled(sendId: string, ok: boolean, reason?: string): void;
  emitSettledFor(spec: { threadId: string; sendId: string; ok: boolean; reason?: string }): void;
  isStreaming(): boolean;
  commandBusy(): boolean;
  childBusy(): boolean;
}

/** session 事件 → wire payload：{seq, time, ...data, session, surfaceOp?}——session 后置（事件
 *  数据词表无 session 键，不遮蔽；主会话 session === threadId，客户端一条规则过滤归属）。
 *  surfaceOp 随附（与 get_entries 条目投影 projectEntry 同形）：消费方靠它区分 replace 型
 *  载体（压缩摘要）与 append 型真话，以及识别边沿注入快照（快照谓词要求 append）。 */
function sessionPayload(event: SessionEvent, session: string): Record<string, unknown> {
  return {
    seq: event.seq,
    time: event.time,
    ...(event.data as Record<string, unknown>),
    session,
    ...(event.surfaceOp !== undefined ? { surfaceOp: event.surfaceOp } : {}),
  };
}

function settleOfTurnEnd(event: SessionEvent): { ok: boolean; reason: string | undefined } {
  const reason = (event.data as { reason?: { kind?: string; message?: string; reason?: string } }).reason;
  const kind = reason?.kind;
  if (kind !== "error" && kind !== "blocked") return { ok: true, reason: undefined };
  const detail = kind === "error" ? reason?.message : reason?.reason;
  return { ok: false, reason: detail !== undefined && detail !== "" ? detail : kind };
}

export function createEventBridge(deps: EventBridgeDeps): EventBridge {
  const offs: Array<() => void> = [];
  let streaming = false;
  const partial = createPartialAccumulator();
  const childStatuses = new Map<string, "idle" | "running">();
  const childNames = new Map<string, { agentId: string; type: string }>();
  let llmTurn = 0;
  let llmStep = 0;
  let commandBusyCount = 0;
  let turnScanFrom: number | null = null;

  function emitInternalSettled(): void {
    const threadId = deps.threadId();
    const events = deps.mainEvents();
    if (threadId === "" || events === undefined) return;
    if (deps.pendingSends() > 0) return;
    const from = turnScanFrom;
    if (from === null) return;
    turnScanFrom = null;
    let settled = { ok: true, reason: undefined as string | undefined };
    for (const event of events) {
      if (event.seq < from || event.type !== "turn/end") continue;
      settled = settleOfTurnEnd(event);
    }
    deps.emitLine(
      eventFrame({ threadId, name: "settled", payload: { sendId: "", ok: settled.ok, ...(settled.reason !== undefined ? { reason: settled.reason } : {}) } }),
    );
  }

  function emit(name: string, payload: unknown): void {
    const threadId = deps.threadId();
    if (threadId === "") return;
    const owner = (payload as { session?: unknown }).session;
    const named = owner !== undefined ? childNames.get(String(owner)) : undefined;
    deps.emitLine(eventFrame({ threadId, name, payload, ...(named !== undefined ? { agentName: named.agentId } : {}) }));
  }

  interface ToolStreamPending {
    owner: string;
    callId: string;
    pending: string;
    timer: ReturnType<typeof setTimeout> | undefined;
    lastAt: number;
  }
  const toolStream = new Map<string, ToolStreamPending>();

  function emitToolStreamFrame(state: ToolStreamPending): void {
    const chunk = state.pending;
    state.pending = "";
    state.lastAt = Date.now();
    if (chunk !== "") emit(agentToolStream.name, { session: state.owner, callId: state.callId, delta: chunk });
  }

  function settleToolStream(key: string): void {
    const state = toolStream.get(key);
    if (state === undefined) return;
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    emitToolStreamFrame(state);
    toolStream.delete(key);
  }

  function settleOwnerStreams(owner: string): void {
    for (const [key, state] of toolStream) {
      if (state.owner === owner) settleToolStream(key);
    }
  }

  function feedToolStream(owner: string, callId: string, delta: string): void {
    const main = owner === deps.threadId();
    if (main) deps.inflight.toolOutput(callId, delta);
    const key = `${owner}:${callId}`;
    const state = toolStream.get(key) ?? { owner, callId, pending: "", timer: undefined, lastAt: 0 };
    toolStream.set(key, state);
    state.pending += delta;
    if (state.timer === undefined) {
      const wait = Math.max(0, TOOL_STREAM_MIN_INTERVAL_MS - (Date.now() - state.lastAt));
      const timer = setTimeout(() => {
        state.timer = undefined;
        if (toolStream.get(key) !== state) return;
        emitToolStreamFrame(state);
      }, wait);
      timer.unref?.();
      state.timer = timer;
    }
  }

  function clearToolStream(): void {
    for (const state of toolStream.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer);
    }
    toolStream.clear();
  }

  function onSessionEvent(owner: string, event: SessionEvent): void {
    const main = owner === deps.threadId();
    if (event.type === "turn/start") {
      if (main) {
        streaming = true;
        partial.reset();
        deps.inflight.turnStart(event.seq, event.time);
        turnScanFrom = event.seq;
      }
    } else if (event.type === "turn/end") {
      settleOwnerStreams(owner);
      if (main) {
        streaming = false;
        deps.inflight.turnEnd();
        partial.reset();
      }
    } else if (event.type === "tool/call") {
      if (main) deps.inflight.toolOutput(event.data.callId, "");
    } else if (event.type === "tool/result") {
      settleToolStream(`${owner}:${event.data.callId}`);
      if (main) deps.inflight.toolDone(event.data.callId);
    } else if (main && event.type === "command/run") {
      commandBusyCount += 1;
    } else if (main && event.type === "command/done") {
      commandBusyCount = Math.max(0, commandBusyCount - 1);
    }
    emit(event.type, sessionPayload(event, owner));
  }

  return {
    wire(ctx: Context) {
      this.unsubscribe();
      offs.push(
        ctx.on(sessionEvent, ({ session, event }) => onSessionEvent(String(session), event)),
        ctx.on(sessionDisposed, ({ session }) => {
          const owner = String(session);
          childStatuses.delete(owner);
          childNames.delete(owner);
          settleOwnerStreams(owner);
          if (owner === deps.threadId()) commandBusyCount = 0;
        }),
        ctx.on(agentAssistantStream, (payload) => {
          if (String(payload.session) === deps.threadId()) {
            llmTurn = payload.turn;
            llmStep = payload.step;
            if (payload.frame.phase === "chunk") {
              partial.pushChunk(payload.frame.kind, payload.frame.text);
              deps.inflight.partial(partial.snapshot());
            }
          }
          emit(agentAssistantStream.name, payload);
        }),
        ctx.on(agentToolStream, (payload) => {
          feedToolStream(String(payload.session), payload.callId, payload.delta);
        }),
        ctx.on(agentSpawned, (payload) => {
          childNames.set(String(payload.sessionId), { agentId: payload.agentId, type: payload.type });
          emit(agentSpawned.name, payload);
        }),
        ctx.on(agentFinished, (payload) => {
          emit(agentFinished.name, payload);
        }),
        ctx.on(agentStatus, (payload) => {
          const threadId = deps.threadId();
          if (threadId !== "" && String(payload.session) !== threadId) {
            childStatuses.set(String(payload.session), payload.status);
          }
          if (String(payload.session) === threadId && payload.status === "idle") emitInternalSettled();
          emit(agentStatus.name, payload);
        }),
        ctx.on(agentError, (payload) => emit(agentError.name, payload)),
        ctx.on(compactionLanded, (payload) => emit(compactionLanded.name, payload)),
        ctx.on(compactionServedWindow, (payload) => emit(compactionServedWindow.name, payload)),
        ctx.on(compactionDiagnostic, (payload) => emit(compactionDiagnostic.name, payload)),
        ctx.on(autocompactCheckpoint, (payload) => emit(autocompactCheckpoint.name, payload)),
        ctx.on(autocompactDiagnostic, (payload) => emit(autocompactDiagnostic.name, payload)),
        ctx.on(autocompactL1Cleared, (payload) => emit(autocompactL1Cleared.name, payload)),
        ctx.on(autocompactL2Escalated, (payload) => emit(autocompactL2Escalated.name, payload)),
        ctx.on(autocompactLinesDegraded, (payload) => emit(autocompactLinesDegraded.name, payload)),
        ctx.on(autocompactParallelApproach, (payload) => emit(autocompactParallelApproach.name, payload)),
        ctx.on(autocompactBreaker, (payload) => emit(autocompactBreaker.name, payload)),
        ctx.on(permissionDecided, (payload) => emit(permissionDecided.name, payload)),
        ctx.on(checkpointDiagnostic, (payload) => emit(checkpointDiagnostic.name, payload)),
      );
      offs.push(
        ctx.on(llmStream, (request: LlmRequest, next: (input: LlmRequest) => Promise<AsyncIterable<LlmChunk>>) =>
          tapLlmStream(request, next),
        ),
      );
    },
    unsubscribe() {
      for (const off of offs.splice(0)) off();
      streaming = false;
      commandBusyCount = 0;
      turnScanFrom = null;
      childStatuses.clear();
      childNames.clear();
      partial.reset();
      clearToolStream();
    },
    emitSettled(sendId, ok, reason) {
      emit("settled", { sendId, ok, ...(reason !== undefined ? { reason } : {}) });
    },
    emitSettledFor(spec) {
      if (spec.threadId === "") return;
      deps.emitLine(eventFrame({ threadId: spec.threadId, name: "settled", payload: { sendId: spec.sendId, ok: spec.ok, ...(spec.reason !== undefined ? { reason: spec.reason } : {}) } }));
    },
    isStreaming: () => streaming,
    commandBusy: () => commandBusyCount > 0,
    childBusy: () => {
      for (const status of childStatuses.values()) {
        if (status === "running") return true;
      }
      return false;
    },
  };

  function feedPartial(chunk: LlmChunk): void {
    if (chunk.type === "tool-call-delta" && chunk.argumentsDelta !== undefined) partial.pushToolDelta(chunk.argumentsDelta);
  }

  async function tapLlmStream(request: LlmRequest, next: (input: LlmRequest) => Promise<AsyncIterable<LlmChunk>>): Promise<AsyncIterable<LlmChunk>> {
    const stream = await next(request);
    const main = request.session === undefined || String(request.session) === deps.threadId();
    if (!main) return stream;
    const self = {
      async *[Symbol.asyncIterator](): AsyncIterator<LlmChunk> {
        for await (const chunk of stream) {
          feedPartial(chunk);
          if (chunk.type === "tool-call-delta") deps.inflight.partial(partial.snapshot());
          if (chunk.type !== "thinking-signature") emit("llm/chunk", { turn: llmTurn, step: llmStep, chunk });
          yield chunk;
        }
      },
    };
    return self;
  }
}
