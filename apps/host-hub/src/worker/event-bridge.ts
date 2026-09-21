// 事件桥（DESIGN §4/§5）：world ctx 的 session 域（sessionEvent 镜像 WAL）+ 实时域
// （assistant-stream/status/error/compaction/permission/checkpoint bus 事件）→ wire
// 事件帧（name = 内核 token 原名，payload 逐字转发）。worker 盖章 threadId = 当前
// 会话 id（fork 重键后即新 id——host 逐字转发）。另挂 llm/stream waterfall tap →
// llm/chunk 合成域（工具增量/usage/finish——内核事件面只含 text/thinking）；维护
// 观察态：streaming（turn 配对）、在途喂入（partial 累积/工具占位）、settled 合成。
import type { Context } from "@x-harness/core";
import { sessionDisposed, sessionEvent } from "@x-harness/session";
import type { SessionEvent } from "@x-harness/session";
import { agentAssistantStream, agentError, agentStatus } from "@x-harness/agent-loop";
import { llmStream } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { compactionDiagnostic, compactionLanded, compactionServedWindow } from "@x-harness/compaction";
import { autocompactBreaker, autocompactCheckpoint, autocompactDiagnostic, autocompactL1Cleared, autocompactL2Escalated, autocompactLinesDegraded, autocompactParallelApproach } from "@x-harness/autocompact";
import { permissionDecided } from "@x-harness/permission";
import { checkpointDiagnostic } from "@x-harness/session-checkpoint";
import type { InflightState } from "./inflight.ts";
import { eventFrame } from "../protocol/frames.ts";

export interface EventBridgeDeps {
  emitLine: (line: string) => void;
  threadId: () => string;
  inflight: InflightState;
}

/** 在途 assistant partial 累积器：text/thinking（assistant-stream chunk）+
 * tool-call 增量（llm/chunk）→ 伪消息形状 */
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
  /** 订阅面（装配后接线；换会话重接——旧退订） */
  wire(ctx: Context): void;
  unsubscribe(): void;
  /** settled 合成：驱动命令收敛后调用（ok = 收敛结果面） */
  emitSettled(sendId: string, ok: boolean, reason?: string): void;
  /** settled 合成（显式线程域——fork 替换后旧输入按 kick 时线程盖章） */
  emitSettledFor(spec: { threadId: string; sendId: string; ok: boolean; reason?: string }): void;
  /** 观察态读口（心跳 busy 面消费） */
  isStreaming(): boolean;
  /** 子代理在飞谓词（同步——心跳 busy 面；agentStatus 儿童会话边沿跟踪） */
  childBusy(): boolean;
}

/** session 事件 → wire payload：{seq, time, ...data}（WAL 对账面——客户端以 seq 游标增量拉取） */
function sessionPayload(event: SessionEvent): Record<string, unknown> {
  return { seq: event.seq, time: event.time, ...(event.data as Record<string, unknown>) };
}

export function createEventBridge(deps: EventBridgeDeps): EventBridge {
  const offs: Array<() => void> = [];
  let streaming = false;
  const partial = createPartialAccumulator();
  const childStatuses = new Map<string, "idle" | "running">();
  let llmTurn = 0;
  let llmStep = 0;

  function emit(name: string, payload: unknown): void {
    const threadId = deps.threadId();
    if (threadId === "") return; // 未装配：无盖章不外发
    deps.emitLine(eventFrame({ threadId, name, payload }));
  }

  function onSessionEvent(event: SessionEvent): void {
    if (event.type === "turn/start") {
      streaming = true;
      partial.reset();
      deps.inflight.turnStart(event.seq, event.time);
    } else if (event.type === "turn/end") {
      streaming = false;
      deps.inflight.turnEnd();
      partial.reset();
    } else if (event.type === "tool/call") {
      deps.inflight.toolOutput(event.data.callId, ""); // 在途工具占位（增量流内核无面——完整输出经 WAL）
    } else if (event.type === "tool/result") {
      deps.inflight.toolDone(event.data.callId);
    }
    emit(event.type, sessionPayload(event));
  }

  return {
    wire(ctx: Context) {
      this.unsubscribe();
      offs.push(
        ctx.on(sessionEvent, ({ event }) => onSessionEvent(event)),
        ctx.on(sessionDisposed, ({ session }) => {
          // 子会话终结边沿：忙态表清行（异常终止无 idle 边沿时防恒 busy——idle retire 永不触发的缺陷面）
          childStatuses.delete(String(session));
        }),
        ctx.on(agentAssistantStream, (payload) => {
          llmTurn = payload.turn;
          llmStep = payload.step;
          if (payload.frame.phase === "chunk") {
            partial.pushChunk(payload.frame.kind, payload.frame.text);
            deps.inflight.partial(partial.snapshot());
          }
          emit(agentAssistantStream.name, payload);
        }),
        ctx.on(agentStatus, (payload) => {
          const threadId = deps.threadId();
          if (threadId !== "" && payload.session !== threadId) {
            childStatuses.set(String(payload.session), payload.status); // 子会话边沿（busy 面）
          }
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
      // llm/chunk 合成域：tap llm/stream waterfall（中间件契约——必须调 next）；
      // 逐块转发 LlmChunk（工具增量/usage/finish——内核事件面只含 text/thinking）
      offs.push(
        ctx.on(llmStream, (request: LlmRequest, next: (input: LlmRequest) => Promise<AsyncIterable<LlmChunk>>) =>
          tapLlmStream(request, next),
        ),
      );
    },
    unsubscribe() {
      for (const off of offs.splice(0)) off();
      streaming = false;
      childStatuses.clear();
      partial.reset();
    },
    emitSettled(sendId, ok, reason) {
      emit("settled", { sendId, ok, ...(reason !== undefined ? { reason } : {}) });
    },
    emitSettledFor(spec) {
      if (spec.threadId === "") return;
      deps.emitLine(eventFrame({ threadId: spec.threadId, name: "settled", payload: { sendId: spec.sendId, ok: spec.ok, ...(spec.reason !== undefined ? { reason: spec.reason } : {}) } }));
    },
    isStreaming: () => streaming,
    childBusy: () => {
      for (const status of childStatuses.values()) {
        if (status === "running") return true;
      }
      return false;
    },
  };

  function feedPartial(chunk: LlmChunk): void {
    if (chunk.type === "tool-call-delta" && chunk.argumentsDelta !== undefined) partial.pushToolDelta(chunk.argumentsDelta);
    else if (chunk.type === "text-delta") partial.pushChunk("text", chunk.text);
    else if (chunk.type === "thinking-delta") partial.pushChunk("thinking", chunk.text);
  }

  async function tapLlmStream(request: LlmRequest, next: (input: LlmRequest) => Promise<AsyncIterable<LlmChunk>>): Promise<AsyncIterable<LlmChunk>> {
    const stream = await next(request);
    const self = {
      async *[Symbol.asyncIterator](): AsyncIterator<LlmChunk> {
        for await (const chunk of stream) {
          feedPartial(chunk);
          emit("llm/chunk", { turn: llmTurn, step: llmStep, chunk });
          yield chunk;
        }
      },
    };
    return self;
  }
}
