// 事件桥（DESIGN §4/§5）：world ctx 的 session 域（sessionEvent 镜像 WAL）+ 实时域
// （assistant-stream/status/error/tool-stream/compaction/permission/checkpoint bus 事件）
// → wire 事件帧（name = 内核 token 原名，payload 逐字转发 + session 归属字段）。
// worker 盖章 threadId = 当前会话 id（fork 重键后即新 id——host 逐字转发）。
// 归属纪律（BATCH2 §3）：只有主会话事件喂观察态（streaming/inflight/partial）——
// 子会话事件外发但不污染主线程状态（D1/D2/D3 回归面）；子归属帧填 agentName
// （agentSpawned 事件播种映射，sessionDisposed/unsubscribe 清）。另挂 llm/stream
// waterfall tap → llm/chunk 合成域（仅主会话；子的模型增量经 agent/assistant-stream）。
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
}

/** 在途 assistant partial 累积器：text/thinking（assistant-stream chunk——唯一文本源）+
 *  tool-call 增量（llm/chunk）→ 伪消息形状 */
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

/** session 事件 → wire payload：{seq, time, ...data, session}——session 后置（事件
 *  数据词表无 session 键，不遮蔽；主会话 session === threadId，客户端一条规则过滤归属） */
function sessionPayload(event: SessionEvent, session: string): Record<string, unknown> {
  return { seq: event.seq, time: event.time, ...(event.data as Record<string, unknown>), session };
}

export function createEventBridge(deps: EventBridgeDeps): EventBridge {
  const offs: Array<() => void> = [];
  let streaming = false;
  const partial = createPartialAccumulator();
  const childStatuses = new Map<string, "idle" | "running">();
  const childNames = new Map<string, { agentId: string; type: string }>();
  let llmTurn = 0;
  let llmStep = 0;

  function emit(name: string, payload: unknown): void {
    const threadId = deps.threadId();
    if (threadId === "") return; // 未装配：无盖章不外发
    // 子归属帧填 agentName（frames 死字段激活——DESIGN §4 声明兑现）
    const owner = (payload as { session?: unknown }).session;
    const named = owner !== undefined ? childNames.get(String(owner)) : undefined;
    deps.emitLine(eventFrame({ threadId, name, payload, ...(named !== undefined ? { agentName: named.agentId } : {}) }));
  }

  // —— 工具增量流（BATCH2 §2）：主会话 inflight 逐 delta 追加（get_inflight 恒新鲜）；
  // wire 帧 per-(session,callId) 尾沿合并 ≥25ms（delta 可连接——合并不损；火喉输出下
  // 帧率有界）。清理由结算/轮界/会话终结边沿各归其主（主 tool/result 与子的
  // tool/result、各自 turn/end、sessionDisposed——不留无界 Map 也不丢弃 pending）——
  interface ToolStreamPending {
    owner: string;
    callId: string;
    pending: string;
    timer: ReturnType<typeof setTimeout> | undefined;
    lastAt: number;
  }
  /** 键 = `${owner}:${callId}`——owner 是 SessionId（词法无冒号）故前缀切分无歧义；
   *  键只作寻址不解析，owner/callId 存在 state 里（callId 可为任意串） */
  const toolStream = new Map<string, ToolStreamPending>();

  function emitToolStreamFrame(state: ToolStreamPending): void {
    const chunk = state.pending;
    state.pending = "";
    state.lastAt = Date.now();
    if (chunk !== "") emit(agentToolStream.name, { session: state.owner, callId: state.callId, delta: chunk });
  }

  /** 结算边沿：尾批冲净后撤 entry（终态最后——帧序在 tool/result 之前不保证，
   *  pending 冲净保证增量流完整） */
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

  /** 轮/会话终结边沿：该 owner 的全部在途 entry 冲净（子代理后台跨父轮运行——父
   *  turn/end 只清父自己的） */
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
        if (toolStream.get(key) !== state) return; // 已被结算边沿撤走——死后不发射
        emitToolStreamFrame(state);
      }, wait);
      timer.unref?.();
      state.timer = timer;
    }
  }

  /** 拆线清场：只撤定时器不冲刷（wire 已死，帧无处去） */
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
      }
    } else if (event.type === "turn/end") {
      settleOwnerStreams(owner); // 轮边界：该会话在途尾巴冲净（含子会话——不丢弃增量）
      if (main) {
        streaming = false;
        deps.inflight.turnEnd();
        partial.reset();
      }
    } else if (event.type === "tool/call") {
      if (main) deps.inflight.toolOutput(event.data.callId, ""); // 在途占位（startedAt 基线；增量经 agent/tool-stream）
    } else if (event.type === "tool/result") {
      settleToolStream(`${owner}:${event.data.callId}`); // 结算边沿：尾批冲净后撤状态
      if (main) deps.inflight.toolDone(event.data.callId);
    }
    emit(event.type, sessionPayload(event, owner));
  }

  return {
    wire(ctx: Context) {
      this.unsubscribe();
      offs.push(
        ctx.on(sessionEvent, ({ session, event }) => onSessionEvent(String(session), event)),
        ctx.on(sessionDisposed, ({ session }) => {
          // 子会话终结边沿：忙态表/归属映射清行 + 该会话工具增量尾批冲净（异常终止
          // 无 idle 边沿时防恒 busy；映射/增量流无界增长防线）
          const owner = String(session);
          childStatuses.delete(owner);
          childNames.delete(owner);
          settleOwnerStreams(owner);
        }),
        ctx.on(agentAssistantStream, (payload) => {
          // D2/D3：partial 文本唯一源 = 主会话 stream 帧；llmTurn/llmStep 仅主会话跟踪
          // （子帧曾无条件覆盖全局游标 + 双路喂 partial 双计正文——回归面）
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
      // 逐块转发 LlmChunk（工具增量/usage/finish——内核事件面只含 text/thinking）。
      // 仅主会话（D2）：子的模型增量经 agent/assistant-stream（payload 已含 session），不双通道重复
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
      childNames.clear(); // fork 重键 = wire 重接空置重建（新装配无子）
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
    childBusy: () => {
      for (const status of childStatuses.values()) {
        if (status === "running") return true;
      }
      return false;
    },
  };

  /** tap 喂入面：主会话流仅喂 tool-call 增量（text/thinking 唯一源在 assistant-stream
   *  帧——双路喂曾致 partial 正文双计，D3 回归） */
  function feedPartial(chunk: LlmChunk): void {
    if (chunk.type === "tool-call-delta" && chunk.argumentsDelta !== undefined) partial.pushToolDelta(chunk.argumentsDelta);
  }

  async function tapLlmStream(request: LlmRequest, next: (input: LlmRequest) => Promise<AsyncIterable<LlmChunk>>): Promise<AsyncIterable<LlmChunk>> {
    const stream = await next(request);
    const main = request.session === undefined || String(request.session) === deps.threadId();
    if (!main) return stream; // 子会话流：不合成 llm/chunk（走 assistant-stream），原样放行
    const self = {
      async *[Symbol.asyncIterator](): AsyncIterator<LlmChunk> {
        for await (const chunk of stream) {
          feedPartial(chunk);
          if (chunk.type === "tool-call-delta") deps.inflight.partial(partial.snapshot()); // 工具增量后即发布（否则等下一帧才可见）
          emit("llm/chunk", { turn: llmTurn, step: llmStep, chunk });
          yield chunk;
        }
      },
    };
    return self;
  }
}
