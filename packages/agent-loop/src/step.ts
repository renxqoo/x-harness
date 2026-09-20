// 单步相位（docs/AGENT-LOOP-DRIVER.md §1.4–§1.5）：beginStep（领取+否决+回灌同 id）/ anchorSystem /
// dialStep（拨号+header）/ runAttempt（流结算+retry）/ scheduleTools / settleConclude / stopping 续航。
// driver.ts 持生命周期编排（kick/turn 循环），本文件只装一个 step 的相位函数与共享原语。

import { createHash } from "node:crypto";
import type { LlmChunk, LlmRuntime } from "@x-harness/llm";
import { anchorIndexOf } from "@x-harness/session";
import type { ContentBlock, InboxEntry, InboxTarget, Session, SessionEvent } from "@x-harness/session";
import type { SystemPromptService } from "@x-harness/system-prompt";
import type { ToolRegistry } from "@x-harness/tools";
import { claimStepBatch, claimTurnBatch, foldInbox, insertData } from "./inbox.ts";
import type { InboxState } from "./inbox.ts";
import { executeToolCalls } from "./tool-calls.ts";
import type { ToolCallOutcomeCollected, ToolCallSpec } from "./tool-calls.ts";
import { settleStream, StreamAccumulator } from "./stream.ts";
import { foldDial, headerChanged, lastRequestContext, toToolRefs } from "./request.ts";
import type { Dial } from "./tokens.ts";

export interface DriverDeps {
  readonly session: Session;
  readonly options: ResolvedOptions;
  readonly llm: LlmRuntime;
  readonly tools: ToolRegistry;
  readonly prompt: SystemPromptService;
  readonly emitStatus: (status: "idle" | "running") => void;
  readonly emitError: (turn: number, message: string) => void;
  readonly emitStreamFrame: (turn: number, step: number, frame: unknown) => void;
  readonly dispatchPreStep: (payload: unknown) => Promise<unknown>;
  readonly dispatchRequest: (payload: unknown, dial: Dial) => Promise<Dial>;
  readonly dispatchRequestError: (payload: unknown) => Promise<{ readonly kind: "retry"; readonly dial?: Partial<Dial> } | undefined>;
  readonly dispatchTurnStopping: (payload: unknown) => Promise<void>;
  /** F0② assistant 落账前纠（final = 原样透传） */
  readonly dispatchAssistantSettle: (payload: unknown) => Promise<unknown>;
  /** F0③ 流拦截（final = runtime.stream 原样） */
  readonly dispatchLlmStream: (request: unknown) => Promise<AsyncIterable<LlmChunk>>;
}

export interface ResolvedOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly thinking?: import("@x-harness/llm").ThinkingLevel;
  readonly systemPrompt?: string;
  readonly maxParallelToolCalls: number;
  readonly maxToolResultChars: number;
}

export type TurnOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "aborted"; readonly cause: string }
  | { readonly kind: "blocked" }
  | { readonly kind: "error"; readonly message: string; readonly code?: string }
  | { readonly kind: "max-tokens" };

const OUTCOME_RANK: Record<TurnOutcome["kind"], number> = { completed: 0, "max-tokens": 1, error: 2, aborted: 3, blocked: 4 };

export function mergeOutcome(current: TurnOutcome | undefined, next: TurnOutcome): TurnOutcome {
  if (current === undefined) return next;
  if (OUTCOME_RANK[next.kind] >= OUTCOME_RANK[current.kind]) return next; // aborted 即替换；completed 不升级
  return current;
}

export function abortedOutcome(cause: string | undefined): TurnOutcome {
  return { kind: "aborted", cause: cause ?? "signal" };
}

/** 落账失败即逃逸 throw（会话封存/门拒绝后驱动不可继续假装运行） */
export function appendEvent(session: Session, type: string, data: unknown): SessionEvent {
  const result = session.append(type as never, data as never);
  if (!result.ok) throw new Error(`append-failed:${type}:${result.reason}`);
  return result.value;
}

export function appendSurfaceEvent(session: Session, spec: { readonly type: string; readonly data: unknown; readonly surfaceOp: unknown }): SessionEvent {
  const result = session.append(spec.type as never, spec.data as never, { surfaceOp: spec.surfaceOp } as never);
  if (!result.ok) throw new Error(`append-failed:${spec.type}:${result.reason}`);
  return result.value;
}

export interface TurnScope {
  readonly deps: DriverDeps;
  readonly controller: AbortController;
  readonly turn: number;
}

export type StepEntry =
  | { readonly kind: "enter"; readonly entries: readonly InboxEntry[] }
  | { readonly kind: "blocked" }
  | { readonly kind: "empty" };

export type AssistantSettled = { readonly content: readonly ContentBlock[]; readonly stopReason: "stop" | "max-tokens"; readonly interrupted?: true };

export type ToolFlow =
  | { readonly kind: "none" } // 无 tool_use：不调度
  | { readonly kind: "ran"; readonly collected: ToolCallOutcomeCollected }
  | { readonly kind: "aborted" };

/** 领取 + preStep 否决；reject 回灌已领批次（保原 id 与原 target——repair 的 trailing-claim 按旧 id 回灌依赖同 id 判重） */
export async function beginStep(scope: TurnScope, step: number, isStep0: boolean): Promise<StepEntry> {
  const { deps, controller, turn } = scope;
  const session = deps.session;
  const inbox = foldInbox(session.events());
  const batch = isStep0 ? claimTurnBatch(inbox) : claimStepBatch(inbox);
  if (batch.claimed.length > 0) {
    appendEvent(session, "agent/inbox/spliced", {
      op: "claim",
      target: isStep0 ? "next-turn" : "next-step",
      turn,
      claimed: batch.claimed,
    });
  }
  if (isStep0 && batch.entries.length === 0) return { kind: "empty" };
  const decision = await deps.dispatchPreStep({
    session: session.id,
    turn,
    step,
    messages: session.deriveMessages(),
    claim: batch.entries, // 收口审查 1.1：领取批次进载荷——改写决策的输入源
    signal: controller.signal,
  });
  if (isEnterDecision(decision)) {
    const rewritten = (decision as { readonly messages?: readonly InboxEntry[] }).messages;
    if (rewritten !== undefined) {
      if (!isRewrittenEntries(rewritten)) {
        throw new Error(`pre-step rewrite shape invalid: messages must be an array of { id, content } (got ${JSON.stringify(rewritten).slice(0, 80)})`); // 收口审查 1.4：形状门（对齐 bad-dial 的可读失败）
      }
      if (isStep0 && rewritten.length === 0) {
        appendEvent(session, "agent/inbox/spliced", { op: "clear", reason: "rewritten-empty" }); // 收口审查 1.2：durable 清除意图——repair trailingClaims 由 clear 复位，运行态与恢复态一致
        return { kind: "empty" };
      }
      return { kind: "enter", entries: rewritten }; // 落账走重写版（claim 记原始）
    }
    return { kind: "enter", entries: batch.entries };
  }
  reinsertClaimed(session, inbox, isStep0);
  return { kind: "blocked" };
}

/** 回灌：step0 领取 = next-turn 队首 + next-step 全部；step≥1 = next-step 全部。分原 target 落 insert */
function reinsertClaimed(session: Session, inbox: InboxState, isStep0: boolean): void {
  const turnEntries = isStep0 && inbox.nextTurn.length > 0 ? [inbox.nextTurn[0] as InboxEntry] : [];
  insertBatch(session, "next-turn", turnEntries);
  insertBatch(session, "next-step", inbox.nextStep);
}

function insertBatch(session: Session, target: InboxTarget, entries: readonly InboxEntry[]): void {
  if (entries.length === 0) return;
  appendEvent(session, "agent/inbox/spliced", { op: "insert", target, entries: [...entries] });
}

/** system 锚点：无锚点 append；文本漂移 replace[seq,seq]（锚点谓词 = session anchorIndexOf）。
 *  提交后经 assertVisibleLogged 复核「模型可见必落盘」（debug 旋钮，W3）。 */
export function anchorSystem(scope: TurnScope, step: number): void {
  const { deps, turn } = scope;
  const session = deps.session;
  const systemText = deps.options.systemPrompt ?? deps.prompt.assemble({ sessionId: session.id }).text; // W2C：会话层合并投影（无会话段时与缺省逐字节等价）
  const nodes = session.surface();
  const anchorIndex = anchorIndexOf(nodes);
  let changed = false;
  if (anchorIndex < 0) {
    appendSurfaceEvent(session, { type: "system/message", data: { turn, step, text: systemText }, surfaceOp: "append" });
    changed = true;
  } else {
    const anchor = nodes[anchorIndex];
    if (anchor !== undefined) {
      const anchorText = (anchor.event.data as { text: string }).text ?? "";
      if (anchorText !== systemText) {
        appendSurfaceEvent(session, { type: "system/message", data: { turn, step, text: systemText }, surfaceOp: { op: "replace", startSeq: anchor.seq, endSeq: anchor.seq } });
        changed = true;
      }
    }
  }
  observePrompt({ turn, step, text: systemText, changed });
  assertVisibleLogged(session, systemText);
}

/** 指纹观测线（W3，ELEVATION-DESIGN §2.4 裁决补录）：debug 旋钮下每步输出——指纹可从
 *  落盘 text 现算（不进事件体）；KV cache 前缀命中 = 指纹不变。不进 token-meter
 *  （计量面语义是用量非内容）——记 MIGRATION-W3 §8 裁决补录 */
export function observePrompt(spec: { readonly turn: number; readonly step: number; readonly text: string; readonly changed: boolean }): void {
  if (process.env.X_HARNESS_ASSERT_VISIBLE !== "1") return;
  const fingerprint = createHash("sha256").update(spec.text).digest("hex").slice(0, 16);
  process.stderr.write(`[prompt] turn=${String(spec.turn)} step=${String(spec.step)} fingerprint=${fingerprint} changed=${String(spec.changed)}\n`);
}

/** 「模型可见必落盘」不变量（W3，MIGRATION-W3 §3 三口径）：提交后以 deriveMessages()
 *  的 system 投影复核。口径①静态串——systemText 本就是 options.systemPrompt，比对对象
 *  天然统一；口径② no-op 分支——systemText 为本次现算装配，缓存陈旧先经「锚点≠新装配」
 *  暴露（缓存版本键由 W2C 专测背书）；口径③执行时点——本函数同步执行于提交与派发之间，
 *  无 await 无介入面。失配 throw（fail-loud——不变量违例非降级）。 */
export function assertVisibleLogged(session: Session, systemText: string): void {
  if (process.env.X_HARNESS_ASSERT_VISIBLE !== "1") return;
  const projected = session
    .deriveMessages()
    .filter((message) => message.role === "system")
    .map((message) => message.text)
    .join("\n");
  if (projected !== systemText) {
    throw new Error(`visible-logged invariant violated: system projection (${String(projected.length)} chars) != committed systemText (${String(systemText.length)} chars)`);
  }
}

export type DialStep =
  | { readonly kind: "dial"; readonly dial: Dial; readonly schemas: readonly import("@x-harness/tools").ToolSchema[] }
  | { readonly kind: "no-model" }
  | { readonly kind: "bad-dial" };

/** agentRequest waterfall 输出形状门：非同形字段按违约处置（垃圾不进 header/流） */
function isDialShape(value: unknown): value is Dial {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.model !== "string" || v.model === "") return false;
  if (v.provider !== undefined && typeof v.provider !== "string") return false;
  if (v.temperature !== undefined && typeof v.temperature !== "number") return false;
  if (v.maxTokens !== undefined && (typeof v.maxTokens !== "number" || !Number.isInteger(v.maxTokens))) return false;
  if (v.thinking !== undefined && !["off", "low", "medium", "high"].includes(v.thinking as string)) return false;
  return true;
}

/** provider+model 齐备且位移才落 request/context */
function appendContextIfShifted(session: Session, dial: Dial): void {
  if (dial.provider === undefined) return;
  const last = lastRequestContext(session.events());
  if (last?.provider !== dial.provider || last?.model !== dial.model) {
    appendEvent(session, "request/context", { provider: dial.provider, model: dial.model });
  }
}

export function dialFailure(kind: "no-model" | "bad-dial"): TurnOutcome {
  if (kind === "no-model") return { kind: "error", message: "no model configured", code: "no-model" };
  return { kind: "error", message: "agentRequest returned invalid dial", code: "bad-dial" };
}

/** 流错误 fatal 的收尾映射：源于 abort 则按 aborted（覆盖全序格 aborted > error） */
export function fatalOutcome(controller: AbortController, cancelled: string | undefined, outcome: TurnOutcome): TurnOutcome {
  return controller.signal.aborted ? abortedOutcome(cancelled) : outcome;
}

/** 拨号 waterfall + header/context 落账（header 变化才落） */
export async function dialStep(scope: TurnScope, step: number): Promise<DialStep> {
  const { deps, controller, turn } = scope;
  const session = deps.session;
  const folded = foldDial(deps.options, session.events());
  if ("missing" in folded) return { kind: "no-model" };
  const dial = await deps.dispatchRequest({ session: session.id, turn, step, dial: folded, signal: controller.signal }, folded);
  if (!isDialShape(dial)) return { kind: "bad-dial" };
  const schemas = deps.tools.schemas({ sessionId: session.id }); // 分层投影（ELEVATION-DESIGN §2.2）——restriction 取代 options.tools
  const toolRefs = toToolRefs(schemas);
  if (headerChanged(dial, toolRefs, session.events())) {
    appendEvent(session, "request/header", {
      model: dial.model,
      ...(dial.provider !== undefined ? { provider: dial.provider } : {}),
      ...(dial.temperature !== undefined ? { temperature: dial.temperature } : {}),
      ...(dial.maxTokens !== undefined ? { maxTokens: dial.maxTokens } : {}),
      ...(dial.thinking !== undefined ? { thinking: dial.thinking } : {}),
      tools: toolRefs,
    });
    appendContextIfShifted(session, dial);
  }
  return { kind: "dial", dial, schemas };
}

interface AttemptInput {
  readonly scope: TurnScope;
  readonly dial: Dial;
  readonly schemas: readonly unknown[];
  readonly step: number;
}

type AttemptResult =
  | { readonly kind: "ok"; readonly message: AssistantSettled }
  | { readonly kind: "fatal"; readonly outcome: TurnOutcome };

/** 流结算（attempt 循环）：abort 赛跑、三分支结算、request-error retry */
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
      const stream = await deps.dispatchLlmStream({ // F0③（agent/llm-stream）：agent 层流包裹（final = runtime.stream；全局面在 llm 包 llm/stream）
        model: dial.model,
        ...(dial.provider !== undefined ? { provider: dial.provider } : {}),
        ...(dial.temperature !== undefined ? { temperature: dial.temperature } : {}),
        ...(dial.maxTokens !== undefined ? { maxTokens: dial.maxTokens } : {}),
        ...(dial.thinking !== undefined ? { thinking: dial.thinking } : {}),
        tools: schemas as never,
        messages: session.deriveMessages(), // 请求体纯折叠不变量
        signal,
      });
      if (stream === null || typeof (stream as AsyncIterable<LlmChunk>)[Symbol.asyncIterator] !== "function") {
        throw new Error("agent/llm-stream middleware must return an AsyncIterable (fresh per call——重试重派时中间件须幂等)"); // 收口审查 3.3：可读契约失败（非 TypeError 伪装 LLM 故障）
      }
      for await (const chunk of stream) {
        if (signal.aborted) break; // 收口审查 3.2：弃单后迟到帧守卫（不 push 不 emit）
        accum.push(chunk);
        if (chunk.type === "text-delta") deps.emitStreamFrame(turn, step, { phase: "chunk", kind: "text", text: chunk.text });
        else if (chunk.type === "thinking-delta") deps.emitStreamFrame(turn, step, { phase: "chunk", kind: "thinking", text: chunk.text });
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
      // 失败尝试中断前已收到的 usage 帧随尝试落账（token-meter 失败尝试计费，docs/TOKEN-METER.md §1）
      appendEvent(session, "assistant/attempt", {
        turn,
        step,
        error: settlement.error,
        ...(accum.usageSnapshot !== undefined ? { usage: accum.usageSnapshot } : {}),
      });
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
    // 内核独占（收口审查 2.2）。
    const settled = await settleAssistant({ deps, sessionId: session.id, turn, step, accum, settlement, signal });
    appendSurfaceEvent(session, {
      type: "assistant/message",
      data: {
        turn,
        step,
        content: settled.content,
        ...(usage !== undefined ? { usage } : {}),
        stopReason: settled.stopReason,
        ...(settlement.interrupted === true ? { interrupted: true } : {}),
      },
      surfaceOp: "append",
    });
    deps.emitStreamFrame(turn, step, { phase: "end", kind: "message" });
    return {
      kind: "ok",
      message: { content: settled.content, stopReason: settled.stopReason, ...(settlement.interrupted === true ? { interrupted: true } : {}) },
    };
  }
}

/** 工具调度：contexts 回灌 next-step；abort 感知 */
export async function scheduleTools(scope: TurnScope, step: number, assistant: AssistantSettled): Promise<ToolFlow> {
  const { deps, controller, turn } = scope;
  const session = deps.session;
  const specs: ToolCallSpec[] = assistant.content
    .filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use")
    .map((block) => ({ callId: block.callId, name: block.name, arguments: block.input }));
  if (specs.length === 0) return { kind: "none" };
  const collected = await executeToolCalls(
    {
      session,
      registry: deps.tools,
      signal: controller.signal,
      maxParallel: deps.options.maxParallelToolCalls,
      maxResultChars: deps.options.maxToolResultChars,
      turn,
      step,
      ...(deps.tools.restrictionOf(session.id) !== undefined
        ? { allowedTools: deps.tools.schemas({ sessionId: session.id }).map((schema) => schema.name) }
        : {}),
    },
    specs,
  );
  for (const context of chunkContexts(collected.additionalContexts)) {
    appendEvent(session, "agent/inbox/spliced", insertData("next-step", context));
  }
  if (controller.signal.aborted) return { kind: "aborted" };
  return { kind: "ran", collected };
}

interface ConcludeInput {
  readonly current: TurnOutcome | undefined;
  readonly flow: ToolFlow;
  readonly assistant: AssistantSettled;
  readonly pendingConclude: boolean;
  readonly session: Session;
}

/** 收轮判定：stop 无工具 → completed；concludesTurn 无 contexts → completed；有 contexts → 延后（P16 优先级） */
export function settleConclude(input: ConcludeInput): { readonly turnEnds: TurnOutcome | undefined; readonly pendingConclude: boolean } {
  const { current, flow, assistant, pendingConclude, session } = input;
  let next: TurnOutcome | undefined;
  let pending = pendingConclude;
  if (flow.kind === "ran") {
    const collected = flow.collected;
    pending = false; // 本步工具结果待模型消化：conclude 延后
    if (collected.concludesTurn && collected.additionalContexts.length === 0) next = { kind: "completed" };
    if (collected.concludesTurn && collected.additionalContexts.length > 0) pending = true;
  } else if (assistant.stopReason === "stop") {
    next = { kind: "completed" };
  }
  let turnEnds = current;
  if (next !== undefined) turnEnds = mergeOutcome(current, next);
  if (turnEnds === undefined && pending && foldInbox(session.events()).nextStep.length === 0) turnEnds = { kind: "completed" };
  return { turnEnds, pendingConclude: pending };
}

/** stopping 续航窗口：已有 next-step（流中 steer）直接续航；否则经 stopping dispatch 后重读 */
async function stoppingResumes(scope: TurnScope): Promise<boolean> {
  const { deps, controller, turn } = scope;
  if (foldInbox(deps.session.events()).nextStep.length > 0) return true;
  await deps.dispatchTurnStopping({ session: deps.session.id, turn, signal: controller.signal });
  return foldInbox(deps.session.events()).nextStep.length > 0;
}

export async function maybeResume(scope: TurnScope, turnEnds: TurnOutcome | undefined): Promise<TurnOutcome | undefined> {
  if (turnEnds?.kind !== "completed") return turnEnds;
  return (await stoppingResumes(scope)) ? undefined : turnEnds;
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

/** 改写条目形状门（收口审查 1.4）：{ id: string, content: ContentBlock[] } 数组 */
function isRewrittenEntries(value: unknown): value is readonly InboxEntry[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => typeof entry === "object" && entry !== null && typeof (entry as InboxEntry).id === "string" && Array.isArray((entry as InboxEntry).content));
}

function isEnterDecision(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>)["kind"] === "enter";
}

/** contexts 分块：每块最多 1 个 text 块（insert 事件 entries 对齐） */
function chunkContexts(contexts: readonly ContentBlock[]): ContentBlock[][] {
  return contexts.map((block) => [block]);
}
