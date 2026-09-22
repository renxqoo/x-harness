// 单次 LLM attempt 的流汲取与结算（docs/AGENT-LOOP-DRIVER.md §1.4）：看门狗汲取、attempt
// 落账、abort 赛跑、三分支结算（message/attempt）、request-error retry、F0② 落账前纠。
// 从 step.ts 拆出（一动词一文件：step 装步相位，attempt 装单次请求生命周期）。

import type { LlmChunk } from "@x-harness/llm";
import type { ContentBlock, Session } from "@x-harness/session";
import type { Dial } from "./tokens.ts";
import type { DriverDeps, TurnOutcome, TurnScope } from "./step.ts";
import type { AssistantSettled } from "./step.ts";
import { appendEvent, appendSurfaceEvent } from "./step.ts";
import { raceIdleChunk, settleStream, StreamAccumulator } from "./stream.ts";

export type { AssistantSettled };

export interface AttemptInput {
  readonly scope: TurnScope;
  readonly dial: Dial;
  readonly schemas: readonly unknown[];
  readonly step: number;
}

type AttemptResult =
  | { readonly kind: "ok"; readonly message: AssistantSettled }
  | { readonly kind: "fatal"; readonly outcome: TurnOutcome };

/** 流结算（attempt 循环）：abort 赛跑、三分支结算、request-error retry */
/** 看门狗守卫的流汲取：逐 chunk 间隔计时；超时注入 finish{error,code:network}（走 finish
 *  分支携带 code——throw 路径无 code 会导致 llm-retry 不重试；不抛 AbortError 防误判取消）。
 *  超时后 pending 的迭代推进由 raceIdleChunk 附挂 catch 收殓；iterator.return 尽力收殓
 *  （挂起流可能永不落定——LLM-PI 契约，泄漏止损靠 abort signal） */
async function drainGuarded(input: {
  readonly iterator: AsyncIterator<LlmChunk>;
  readonly idleMs: number;
  readonly onTimeout: () => void;
  readonly turnSignal: AbortSignal;
  readonly push: (chunk: LlmChunk) => void;
  readonly emit: (chunk: LlmChunk) => void;
}): Promise<void> {
  try {
    for (;;) {
      const next = await raceIdleChunk(input.iterator.next(), input.idleMs);
      if (next.timedOut) {
        input.onTimeout(); // 掐底层 fetch
        input.push({ type: "finish", finish: { kind: "error", message: "stream idle timeout", code: "network" } });
        return;
      }
      if (next.value.done === true) return;
      const chunk = next.value.value;
      if (input.turnSignal.aborted) return; // 收口审查 3.2：弃单后迟到帧守卫（不 push 不 emit）
      input.push(chunk);
      input.emit(chunk);
    }
  } finally {
    void input.iterator.return?.(undefined as never).catch(() => {}); // 正常/异常/超时退出均尽力收殓（幂等）
  }
}

/** attempt 落账：error + 截止错误时已收增量（content/thinking——STREAM-PARTIAL-PERSISTENCE，
 *  不丢弃上游已交付数据）+ usage（token-meter 失败尝试计费，docs/TOKEN-METER.md §1） */
function appendAttemptLedger(session: Session, spec: { readonly turn: number; readonly step: number; readonly error: string; readonly accum: StreamAccumulator }): void {
  const partialContent = [...spec.accum.textBlock, ...spec.accum.toolUseBlocks];
  appendEvent(session, "assistant/attempt", {
    turn: spec.turn,
    step: spec.step,
    error: spec.error,
    ...(partialContent.length > 0 ? { content: partialContent } : {}),
    ...(spec.accum.thinkingText !== "" ? { thinking: spec.accum.thinkingText } : {}),
    ...(spec.accum.usageSnapshot !== undefined ? { usage: spec.accum.usageSnapshot } : {}),
  });
}

/** ok 出口消息构造：rawReason（provider 原生 stop reason——收束窗口载荷）、hasThinking
 *  （思考型截断判定）与 interrupted 的可选字段折叠收口于此（runAttempt 复杂度治理） */
function settledMessageOf(
  settled: { readonly content: readonly ContentBlock[]; readonly stopReason: "stop" | "max-tokens" },
  settlement: { readonly rawReason?: string; readonly interrupted?: true },
  hasThinking: boolean,
): AssistantSettled {
  return {
    content: settled.content,
    stopReason: settled.stopReason,
    ...(settlement.rawReason !== undefined ? { rawReason: settlement.rawReason } : {}),
    ...(hasThinking ? { hasThinking: true } : {}),
    ...(settlement.interrupted === true ? { interrupted: true } : {}),
  };
}

export async function runAttempt(input: AttemptInput): Promise<AttemptResult> {
  const { scope, schemas, step } = input;
  const { deps, turn } = scope;
  const session = deps.session;
  let dial = input.dial; // 可变：retry 携 dial 补丁时就地合并（requestError pre-stable 扩展）
  const signal = scope.controller.signal;
  for (;;) {
    const accum = new StreamAccumulator();
    let threw: unknown;
    deps.emitStreamFrame(turn, step, { phase: "start" });
    // abort 与流消费赛跑：悬停的流在 cancel 后必须被打断（部分文本保序结算）；监听器赛后拆净
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DOMException("aborted", "AbortError"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    const consume = async (): Promise<void> => {
      // attempt 级止损信号：turn 取消联动穿透；看门狗超时只断本请求（不动 turn——取消语义独占）。
      // 换绑 dispatchLlmStream 的 signal 使 abort 打得到底层 fetch（否则挂死流继续泄漏在生成器里）
      const attempt = new AbortController();
      const onTurnAbort = (): void => attempt.abort();
      if (signal.aborted) attempt.abort();
      else signal.addEventListener("abort", onTurnAbort, { once: true });
      try {
        const stream = await deps.dispatchLlmStream({ // F0③（agent/llm-stream）：agent 层流包裹（final = runtime.stream；全局面在 llm 包 llm/stream）
          model: dial.model,
          ...(dial.provider !== undefined ? { provider: dial.provider } : {}),
          session: session.id, // 流 tap 归属判据（子代理流过滤——BATCH2 §3）
          ...(dial.temperature !== undefined ? { temperature: dial.temperature } : {}),
          ...(dial.maxTokens !== undefined ? { maxTokens: dial.maxTokens } : {}),
          ...(dial.thinking !== undefined ? { thinking: dial.thinking } : {}),
          tools: schemas as never,
          messages: session.deriveMessages(), // 请求体纯折叠不变量
          signal: attempt.signal,
        });
        if (stream === null || typeof (stream as AsyncIterable<LlmChunk>)[Symbol.asyncIterator] !== "function") {
          throw new Error("agent/llm-stream middleware must return an AsyncIterable (fresh per call——重试重派时中间件须幂等)"); // 收口审查 3.3：可读契约失败（非 TypeError 伪装 LLM 故障）
        }
        await drainGuarded({
          iterator: stream[Symbol.asyncIterator](),
          idleMs: deps.options.streamIdleTimeoutMs,
          onTimeout: () => attempt.abort(),
          turnSignal: signal,
          push: (chunk) => accum.push(chunk),
          emit: (chunk) => {
            if (chunk.type === "text-delta") deps.emitStreamFrame(turn, step, { phase: "chunk", kind: "text", text: chunk.text });
            else if (chunk.type === "thinking-delta") deps.emitStreamFrame(turn, step, { phase: "chunk", kind: "thinking", text: chunk.text });
          },
        });
      } finally {
        signal.removeEventListener("abort", onTurnAbort); // per-attempt 监听不跨尝试累积
      }
    };
    try {
      await Promise.race([consume(), aborted]);
    } catch (error) {
      threw = error;
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
    const settlement = settleStream(accum, threw, signal.aborted);
    if (settlement.kind === "attempt") {
      appendAttemptLedger(session, { turn, step, error: settlement.error, accum });
      deps.emitStreamFrame(turn, step, { phase: "end", kind: "attempt" });
      const retry = await deps.dispatchRequestError({
        session: session.id,
        turn,
        step,
        failure: {
          message: settlement.error,
          ...(settlement.code !== undefined ? { code: settlement.code } : {}),
          ...(settlement.retryAfterMs !== undefined ? { retryAfterMs: settlement.retryAfterMs } : {}),
        },
        signal,
      });
      if (retry?.kind === "retry" && !signal.aborted) {
        if (retry.dial !== undefined) dial = { ...dial, ...retry.dial }; // 降级补丁（不重派 agentRequest——dsh 同口径）
        continue; // 不重落 system/user/header
      }
      return { kind: "fatal", outcome: { kind: "error", message: settlement.error } };
    }
    const usage = accum.usageSnapshot;
    // F0②：assistant 落账前纠——改写版即落账版（「模型可见必落盘」保持）。形状门在
    // settleAssistant 内（收口审查 2.1）；输出契约只 content/stopReason——interrupted 由
    // 内核独占（收口审查 2.2）。thinking 为落盘旁路字段（不过纠中间件、不进投影——
    // docs/STREAM-PARTIAL-PERSISTENCE.md）。
    const settled = await settleAssistant({ deps, sessionId: session.id, turn, step, accum, settlement, signal });
    appendSurfaceEvent(session, {
      type: "assistant/message",
      data: {
        turn,
        step,
        content: settled.content,
        ...(accum.thinkingText !== "" ? { thinking: accum.thinkingText } : {}),
        ...(usage !== undefined ? { usage } : {}),
        stopReason: settled.stopReason,
        ...(settlement.interrupted === true ? { interrupted: true } : {}),
      },
      surfaceOp: "append",
    });
    deps.emitStreamFrame(turn, step, { phase: "end", kind: "message" });
    return { kind: "ok", message: settledMessageOf(settled, settlement, accum.thinkingText !== "") };
  }
}


/** F0② 落账前纠派发（含形状门）。注：**不与 abort 赛跑**——中断是合法完成态（部分消息结算
 *  必须照常落账）；中间件挂起防护与 preStep/request 同契约（waterfall 不得无限挂起——文档承载）。
 *  输出契约只 content/stopReason：interrupted 由内核独占（收口审查 2.2）。 */
async function settleAssistant(spec: {
  readonly deps: DriverDeps;
  readonly sessionId: import("@x-harness/session").SessionId;
  readonly turn: number;
  readonly step: number;
  readonly accum: StreamAccumulator;
  readonly settlement: { stopReason: "stop" | "max-tokens"; interrupted?: true };
  readonly signal: AbortSignal;
}): Promise<{ content: readonly ContentBlock[]; stopReason: "stop" | "max-tokens" }> {
  const settled = await spec.deps.dispatchAssistantSettle({
    session: spec.sessionId,
    turn: spec.turn,
    step: spec.step,
    content: [...spec.accum.textBlock, ...spec.accum.toolUseBlocks],
    stopReason: spec.settlement.stopReason,
    ...(spec.settlement.interrupted === true ? { interrupted: true } : {}),
    signal: spec.signal,
  }) as { content?: unknown; stopReason?: unknown };
  if (!isSettlementShape(settled)) {
    throw new Error(`agent/assistant-settle output shape invalid: stopReason must be "stop" | "max-tokens" (got ${JSON.stringify(settled?.stopReason)})`);
  }
  return settled;
}

/** settle 输出形状门（收口审查 2.1）：content 数组 + stopReason 闭集 */
function isSettlementShape(value: unknown): value is { content: readonly ContentBlock[]; stopReason: "stop" | "max-tokens" } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { content?: unknown; stopReason?: unknown };
  return Array.isArray(v.content) && (v.stopReason === "stop" || v.stopReason === "max-tokens");
}

