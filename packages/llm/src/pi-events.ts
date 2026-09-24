// pi-events 映射（docs/LLM-PI.md 契约 2）：pi AssistantMessageEvent → LlmChunk。
// 终态恰一次（done/error 后停发）；abort 豁免（reason aborted / signal 已断 → throw AbortError，
// 对齐 runtime isAbortLike）；error 事件先发 usage（error.usage 折算——失败尝试计费）再发 error finish；
// P10 初值（anthropic 方言，emitStartInitials）：text/thinking_start 时 partial 非空初值补发 delta；
// toolcall 无身份（openai 方言首块缺 id）缓冲至 toolcall_end 补发；text/thinking_end 终态校正补发缺失尾段；
// toolcall 原文出口（docs/TRUNCATED-TOOL-RESCUE.md 层 1 前置）：delta 原文按块缓冲、end 帧暂存，
// 全终态（done/error/throw/break）flush——缓冲原文 parse 失败的块发原文（未经 pi 修补），
// 成功的照旧 stringify；正常流帧形状逐字节不变。

import { isContextOverflow, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { LlmChunk, TokenUsage } from "./types.ts";

/** usage 折算（docs/LLM-PI.md 契约 4 修订——保留明细）：input 仍含 cache 总量
 *  （GLM 桥自动缓存不低计——旧消费方不变）；cacheRead/cacheWrite 可选透传——
 *  下游可算精确缓存率（cacheRead / input）。全零不发。 */
export function foldUsage(usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number; cost?: import("./types.ts").UsageCost } | undefined): LlmChunk[] {
  if (usage === undefined) return [];
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  if (input === 0 && usage.output === 0) return []; // 空快照守卫：缺报后端全零不产噪音帧
  return [{
    type: "usage",
    usage: {
      input,
      output: usage.output,
      ...(usage.cacheRead > 0 ? { cacheRead: usage.cacheRead } : {}),
      ...(usage.cacheWrite > 0 ? { cacheWrite: usage.cacheWrite } : {}),
      ...(usage.totalTokens !== undefined && usage.totalTokens > 0 ? { totalTokens: usage.totalTokens } : {}),
      ...(usage.cost !== undefined && usage.cost.total > 0 ? { cost: usage.cost } : {}),
    } satisfies TokenUsage,
  }];
}

function blockAt(partial: { content?: unknown } | undefined, index: number): Record<string, unknown> | undefined {
  const content = partial === undefined ? undefined : partial.content;
  if (!Array.isArray(content)) return undefined;
  const block = content[index];
  return typeof block === "object" && block !== null ? (block as Record<string, unknown>) : undefined;
}

/** partial.content[index] 上的文本/思考初值（P10：anthropic 的 start 帧带块初值但不产 delta） */
function initialTextAt(partial: { content?: unknown } | undefined, index: number, kind: "text" | "thinking"): string | undefined {
  const block = blockAt(partial, index);
  if (block === undefined) return undefined;
  if (kind === "text" && block["type"] === "text" && typeof block["text"] === "string" && block["text"] !== "") {
    return block["text"];
  }
  if (kind === "thinking" && block["type"] === "thinking" && typeof block["thinking"] === "string" && block["thinking"] !== "") {
    return block["thinking"];
  }
  return undefined;
}

/** 错误文案分类（fetch 包装层未捕获状态时的兜底）。词边界匹配防数值子串误杀（"used 14290 tokens" ≠ 429）；
 *  refusal/sensitive/content_filter 与鉴权文案显式落 non-retryable（不可重试事实码）。 */
export function classifyErrorText(message: string): string {
  const lower = message.toLowerCase();
  const status = [429, 500, 502, 503, 504, 401, 403].find((code) =>
    new RegExp(`(?:^|[^0-9])${String(code)}(?:[^0-9]|$)`).test(lower),
  );
  if (status !== undefined) return `http-${String(status)}`;
  // 词边界 "refus" 覆盖 pi 真身文案 "The model refused…"（不含 "refusal" 子串），且不误伤
  // ECONNREFUSED（连接拒绝是可重试 network 错误）
  if (/\brefus/.test(lower) || lower.includes("sensitive") || lower.includes("content_filter")) return "non-retryable";
  // 鉴权类文案：重试换不来新凭证——显式 non-retryable
  if (lower.includes("api key") || lower.includes("authentication") || lower.includes("unauthorized") || lower.includes("permission")) {
    return "non-retryable";
  }
  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("network") ||
    lower.includes("fetch failed") ||
    lower.includes("econnrefused") ||
    lower.includes("overloaded")
  ) {
    return "network";
  }
  return "network"; // fail-open 落可重试（与旧未知错误归 network 同策）
}

export interface PiChunkOptions {
  readonly signal: AbortSignal;
  /** 拨号上下文快照（fetch 包装层捕获非 2xx）：状态码在场时 error 落 http-<status>；retry-after 头毫秒 */
  readonly failureInfo: () => { status?: number; retryAfterMs?: number };
  /** anthropic true：content_block_start 的非空初值在 start 帧补发（P10）——anthropic 的
   *  start 与 delta 是不同 SSE 事件、无同步邻接，读 partial 安全；openai false：pi 在同一
   *  同步块里 push start 并把首帧 append 进 partial（读到的必是已变异值），恒不读。 */
  readonly emitStartInitials?: boolean;
}

/** 终态校正：wire 全文 content 以已发拼接为前缀时的缺失尾段（非前缀关系返回空——不强行校正） */
function missingTail(content: string, emitted: string): string {
  if (content.startsWith(emitted) && content.length > emitted.length) return content.slice(emitted.length);
  return "";
}

/** toolcall 出口状态（piChunks generator 局部——每次调用新实例，防跨 attempt 泄漏）：
 *  rawArgs 按 contentIndex 拼接 delta 原文（anthropic 即 partial_json 分片，未经修补）；
 *  identity 记 toolcall_start 时 partial.content[contentIndex] 的累积块 id/name（anthropic
 *  error 路径无 toolcall_end 时的合成身份来源）；pending 暂存 toolcall_end 帧——终态裁决后
 *  放行（docs/TRUNCATED-TOOL-RESCUE.md 层 1 前置）。 */
interface ToolCallState {
  readonly rawArgs: Map<number, string>;
  readonly identity: Map<number, { callId: string; name: string }>;
  readonly pending: Map<number, { callId: string; name: string; args: unknown }>;
  /** 已放行/已合成的块（contentIndex 集）——flush 与合成互斥幂等，终态双路径不重发 */
  readonly emitted: Set<number>;
  appendRaw(index: number, delta: string): void;
  noteIdentity(event: Extract<AssistantMessageEvent, { type: "toolcall_start" }>): void;
  holdEnd(event: Extract<AssistantMessageEvent, { type: "toolcall_end" }>): void;
}

/** toolcall_start 的块身份：partial.content[index] 累积 toolCall 块的 id/name
 *  （content_block_start 已定；缺席方言如 openai 返回 undefined——身份由 end 兜底） */
function identityAt(partial: { content?: unknown } | undefined, index: number): { callId: string; name: string } | undefined {
  const block = blockAt(partial, index);
  if (block === undefined || block["type"] !== "toolCall") return undefined;
  const callId = block["id"];
  const name = block["name"];
  return typeof callId === "string" && typeof name === "string" ? { callId, name } : undefined;
}

/** toolcall 出口适配：pi 的 toolcall_end 携带完整调用（id/name/arguments）——end 帧
 *  暂存不立即发，终态裁决放行（见 pendingChunkAt）。arguments 非对象/缺席落 {}
 *  （与 pi-context parseToolInput 同口径——空参数执行防线）。 */
function holdEndChunks(event: Extract<AssistantMessageEvent, { type: "toolcall_end" }>): { callId: string; name: string; args: unknown } {
  const args = event.toolCall.arguments;
  return { callId: event.toolCall.id, name: event.toolCall.name, args: typeof args === "object" && args !== null && !Array.isArray(args) ? args : {} };
}

/** 完整性裁决（docs/TRUNCATED-TOOL-RESCUE.md 裁决④）：缓冲原文 JSON.parse 成败——
 *  失败 = 半截，发原文本身（未经修补、未经 re-stringify，下游判定与提取才有真转义态）；
 *  成功 = 完整，发 stringify（有 end 修补对象用之——与旧出口逐字节同形；合成帧无修补
 *  对象时以原文 parse 产物归一，出口仍为合法全量 JSON）。 */
function argumentsDeltaFor(raw: string | undefined, normalized: unknown): string {
  if (raw === undefined) return JSON.stringify(normalized);
  if (raw === "") return ""; // 零字符截断原样出口——下游 isTruncatedArguments("") 命中截断分支（折成 "{}" 会让空参真实执行）
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw; // 半截：发原文本身（未修补未 re-stringify）
  }
  return JSON.stringify(normalized !== undefined ? normalized : parsed); // 完整：出口仍全量 JSON
}

/** 暂存帧放行（contentIndex 升序）：全终态 flush 义务的公共出口——done{stop/toolUse} 与
 *  flush 原文判定版共用；已 flush 幂等（flushed 标志在 ToolCallState 之外由 piChunks 持有）。 */
function pendingChunkAt(index: number, held: { callId: string; name: string; args: unknown }, raw: string | undefined): LlmChunk {
  return {
    type: "tool-call-delta",
    index,
    callId: held.callId,
    name: held.name,
    argumentsDelta: argumentsDeltaFor(raw, held.args),
  };
}

/** anthropic error 路径合成（该方言截断块无 toolcall_end——content_block_stop 未到，
 *  pi 侧 catch 已 delete block.partialJson，暂存机制空承诺）：有身份 + 有原文 + 无 end
 *  的块直接从缓冲原文合成帧（完整性同判据），不依赖 toolcall_end。 */
function synthesizeMissingChunks(state: ToolCallState): LlmChunk[] {
  const chunks: LlmChunk[] = [];
  for (const [index, raw] of [...state.rawArgs.entries()].sort(([a], [b]) => a - b)) {
    if (state.emitted.has(index) || state.pending.has(index) || raw === "") continue;
    const identity = state.identity.get(index);
    if (identity === undefined) continue;
    state.emitted.add(index);
    chunks.push({ type: "tool-call-delta", index, callId: identity.callId, name: identity.name, argumentsDelta: argumentsDeltaFor(raw, undefined) });
  }
  return chunks;
}

interface BlockState {
  readonly emittedText: Map<number, string>;
  readonly emitStartInitials: boolean;
  append(index: number, delta: string): void;
}

/** text/thinking 事件族：start 初值（anthropic 方言，state.emitStartInitials）、delta 透传（空跳过）、end 终态校正补尾段 */
function startChunks(event: Extract<AssistantMessageEvent, { type: "text_start" | "thinking_start" }>, state: BlockState, kind: "text" | "thinking"): LlmChunk[] {
  if (state.emitStartInitials !== true) return [];
  const initial = initialTextAt(event.partial, event.contentIndex, kind);
  if (initial === undefined) return [];
  state.append(event.contentIndex, initial);
  return [{ type: kind === "text" ? "text-delta" : "thinking-delta", text: initial }];
}

function deltaChunks(event: Extract<AssistantMessageEvent, { type: "text_delta" | "thinking_delta" }>, state: BlockState, kind: "text" | "thinking"): LlmChunk[] {
  if (event.delta === "") return [];
  state.append(event.contentIndex, event.delta);
  return [{ type: kind === "text" ? "text-delta" : "thinking-delta", text: event.delta }];
}

function endChunks(event: Extract<AssistantMessageEvent, { type: "text_end" | "thinking_end" }>, state: BlockState, kind: "text" | "thinking"): LlmChunk[] {
  const missing = missingTail(event.content, state.emittedText.get(event.contentIndex) ?? "");
  if (missing === "") return [];
  state.append(event.contentIndex, missing);
  return [{ type: kind === "text" ? "text-delta" : "thinking-delta", text: missing }];
}

function blockChunks(event: AssistantMessageEvent, state: BlockState): LlmChunk[] {
  const kind: "text" | "thinking" = event.type.startsWith("text") ? "text" : "thinking";
  if (event.type === "text_start" || event.type === "thinking_start") return startChunks(event, state, kind);
  if (event.type === "text_delta" || event.type === "thinking_delta") return deltaChunks(event, state, kind);
  if (event.type === "text_end" || event.type === "thinking_end") return endChunks(event, state, kind);
  return [];
}

/** 原生输出上限词表：pi `openai-completions mapStopReason` 对非标 finish_reason 全落
 *  default→error（`max_tokens` 即中招）——这些原生值随 partial 内容到达 error 事件时，
 *  语义是输出截断而非请求失败，在 errorChunks 救回为 max-tokens 终态（与
 *  refusal/sensitive/content_filter 同点归一，docs/OUTPUT-TOKEN-CONTINUATION.md 批1）。 */
const OUTPUT_LIMIT_RAW_REASONS: ReadonlySet<string> = new Set(["max_tokens", "max_output_tokens", "model_context_window_exceeded"]);

/** 输出上限词处置（errorChunks 复杂度治理）：有内容 → 救回 max-tokens（wire 归一——
 *  mapStopReason 把输出上限折 error 是 pi 方言事实）；零内容 → context-overflow 终态
 *  分类（零内容截断无 partial 可接续——事实归一，处置序归消费端）；非输出上限词 →
 *  undefined 走后续判定链 */
function outputLimitFinish(rawStop: string | undefined, hasContent: boolean, message: string): LlmChunk | undefined {
  if (rawStop === undefined || !OUTPUT_LIMIT_RAW_REASONS.has(rawStop)) return undefined;
  if (hasContent) return { type: "finish", finish: { kind: "max-tokens", rawReason: rawStop } };
  return { type: "finish", finish: { kind: "error", message, code: "context-overflow" } };
}

/** error 终态：abort 抛 AbortError（豁免）；usage 先行；rawStopReason 判定序——
 *  ① 输出上限救回（须流内已有内容：零内容截断没有可接续的 partial，防空 assistant/message
 *    与「指令对着不存在的中断」的续写）；② 零内容输出上限词 → context-overflow 终态分类；③
 *    overflow 文本分类（优先于状态码——主力 provider 的输入溢出是 HTTP 400 + overflow 文案；
 *    状态码在场也照报 context-overflow——限流文案误命中的甄别归消费端重试词表）；④
 *    refusal/sensitive/content_filter 落 non-retryable；⑤ 状态码在场落 http-<status>；⑥ 文案
 *    分类兜底。rawStopReason 在场即随终态透传（rawReason——诊断事实，非处置信号）。 */
function errorChunks(event: Extract<AssistantMessageEvent, { type: "error" }>, options: PiChunkOptions, hasContent: boolean): LlmChunk[] {
  if (event.reason === "aborted" || options.signal.aborted) throw new DOMException("aborted", "AbortError");
  const chunks = [...foldUsage(event.error.usage)]; // 失败尝试已见 usage 随流落账（token-meter 计费）
  const message = event.error.errorMessage ?? "pi stream error";
  const rawStop = (event.error as { rawStopReason?: string }).rawStopReason;
  const info = options.failureInfo();
  const rescued = outputLimitFinish(rawStop, hasContent, message);
  if (rescued !== undefined) {
    chunks.push(rescued);
    return chunks;
  }
  if (isContextOverflow({ ...event.error, stopReason: "error" })) { // stopReason 合成：error 事件的消息定义上即错误终态（isContextOverflow 文案分支要求该字段在场）
    chunks.push({ type: "finish", finish: { kind: "error", message, code: "context-overflow", ...(rawStop !== undefined ? { rawReason: rawStop } : {}) } });
    return chunks;
  }
  const nonRetryable = rawStop === "refusal" || rawStop === "sensitive" || rawStop === "content_filter";
  let code: string;
  if (nonRetryable) code = "non-retryable";
  else if (info.status !== undefined) code = `http-${String(info.status)}`;
  else code = classifyErrorText(message);
  chunks.push({
    type: "finish",
    finish: {
      kind: "error",
      message,
      code,
      ...(info.retryAfterMs !== undefined ? { retryAfterMs: info.retryAfterMs } : {}),
      ...(rawStop !== undefined ? { rawReason: rawStop } : {}),
    },
  });
  return chunks;
}

/** done 终态帧（piChunks 复杂度治理）：length + usage.output===0 → context-overflow（零输出
 *  截断——pi overflow.js Case 3 同源，MiMo 截输入塞满窗口致无输出空间；合法的输出上限命中
 *  必有 output>0）；length → max-tokens（携 rawReason）；其余 stop。 */
function doneFinish(message: { usage?: { output?: number }; rawStopReason?: string }, reason: string): LlmChunk {
  if (reason !== "length") return { type: "finish", finish: { kind: "stop" } };
  if ((message.usage?.output ?? -1) === 0) {
    return { type: "finish", finish: { kind: "error", message: "length stop with zero output (context window overflow)", code: "context-overflow" } };
  }
  const raw = message.rawStopReason;
  return { type: "finish", finish: { kind: "max-tokens", ...(raw !== undefined ? { rawReason: raw } : {}) } };
}

export async function* piChunks(events: AsyncIterable<AssistantMessageEvent>, options: PiChunkOptions): AsyncGenerator<LlmChunk> {
  const emittedText = new Map<number, string>(); // contentIndex → 已发 delta 拼接（终态校正用）
  let sawContent = false; // text/toolcall 已发（thinking 不计——与 loop 侧 StreamAccumulator.hasContent 同口径；error 救回的内容前置判定用）
  const toolState: ToolCallState = {
    rawArgs: new Map(),
    identity: new Map(),
    pending: new Map(),
    emitted: new Set<number>(),
    appendRaw: (index, delta) => {
      toolState.rawArgs.set(index, (toolState.rawArgs.get(index) ?? "") + delta);
    },
    noteIdentity: (event) => {
      const identity = identityAt(event.partial, event.contentIndex);
      if (identity !== undefined) toolState.identity.set(event.contentIndex, identity);
    },
    holdEnd: (event) => {
      toolState.pending.set(event.contentIndex, holdEndChunks(event));
    },
  };
  const state: BlockState = {
    emittedText,
    emitStartInitials: options.emitStartInitials === true,
    append: (index, delta) => {
      emittedText.set(index, (emittedText.get(index) ?? "") + delta);
    },
  };
  /** 暂存帧兜底放行（恰一次——flushed 标志幂等）：end 即发后 pending 恒空，此出口
   *  仅防御非终态路径的结构完整性；emitted 集保证不与 end 放行重发。 */
  let flushed = false;
  function* flushPending(): Generator<LlmChunk> {
    if (flushed) return;
    flushed = true;
    for (const [index, held] of [...toolState.pending.entries()].sort(([a], [b]) => a - b)) {
      if (toolState.emitted.has(index)) continue;
      toolState.emitted.add(index);
      yield pendingChunkAt(index, held, toolState.rawArgs.get(index));
    }
  }
  const iterator = events[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      const event = next.value;
      if (event.type === "done") {
        yield* foldUsage(event.message.usage);
        yield* flushPending();
        const synthesized = synthesizeMissingChunks(toolState); // 无 end 块（违约流防御层）：合成帧不得晚于 finish（头注「done/error 后停发」）
        sawContent = sawContent || synthesized.length > 0;
        yield* synthesized;
        yield doneFinish(event.message, event.reason);
        return;
      }
      if (event.type === "error") {
        // error 终态前放行暂存帧 + 合成 anthropic 无 end 块（openai 方言 end 已入暂存；
        //  anthropic 截断块靠 identity+rawArgs 合成）——判定不依赖 reason（同判据）。
        //  放行/合成帧先于 errorChunks 结算 sawContent（合成块即流内已交付内容——救回前置成立）
        yield* flushPending();
        const synthesized = synthesizeMissingChunks(toolState);
        sawContent = sawContent || synthesized.length > 0;
        yield* synthesized;
        yield* errorChunks(event, options, sawContent);
        return;
      }
      if (event.type === "toolcall_end") {
        // end 即放行（不暂存）：完整性判定只依赖该块自己的缓冲原文（JSON.parse 即判，
        // 不依赖流终态）——早发消灭 abort/看门狗窗口丢帧（end 后终态前的暂存帧会随
        // 消费侧 fire-and-forget return() 蒸发）。截断块此时缓冲已齐（end = 该块分片
        // 终点），判据与终态裁决完全同源。
        const held = holdEndChunks(event);
        toolState.emitted.add(event.contentIndex);
        sawContent = true;
        yield pendingChunkAt(event.contentIndex, held, toolState.rawArgs.get(event.contentIndex));
        continue;
      }
      if (event.type === "toolcall_start") {
        toolState.noteIdentity(event);
        continue; // 分片不透传——end 单帧出口（见 pendingChunkAt）
      }
      if (event.type === "toolcall_delta") {
        toolState.appendRaw(event.contentIndex, event.delta);
        continue;
      }
      const chunks = blockChunks(event, state);
      sawContent = sawContent || chunks.some((chunk) => chunk.type === "text-delta");
      yield* chunks;
    }
  } catch (error) {
    // 上游异常 unwinding 时 finally 的 yield 不可达（异常路径 generator finally 不恢复执行）——
    // 此处 flush 后 rethrow，与 break/return 路径（finally flush）共同闭合全终态 flush 义务
    yield* flushPending();
    yield* synthesizeMissingChunks(toolState);
    throw error;
  } finally {
    // 提前 break/return（消费者 break、看门狗 return()、abort）：flush 暂存帧（幂等）+
    // 尽力终止上游迭代器（fire-and-forget——pi 的 EventStream 挂在内部 await 时
    // await return() 会 pending 到下一事件；流止损靠 abort signal，见 LLM-PI.md 契约）
    yield* flushPending();
    yield* synthesizeMissingChunks(toolState);
    void iterator.return?.(undefined as never).catch(() => {});
  }
  // 事件流自然耗尽无终态（防御层：pi 词表保证 done/error 收尾，此处兜底违约流）
  yield { type: "finish", finish: { kind: "error", message: "stream ended without finish", code: "network" } };
}
