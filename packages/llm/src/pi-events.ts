// pi-events 映射（docs/LLM-PI.md 契约 2）：pi AssistantMessageEvent → LlmChunk。
// 终态恰一次（done/error 后停发）；abort 豁免（reason aborted / signal 已断 → throw AbortError，
// 对齐 runtime isAbortLike）；error 事件先发 usage（error.usage 折算——失败尝试计费）再发 error finish；
// P10 初值（anthropic 方言，emitStartInitials）：text/thinking_start 时 partial 非空初值补发 delta；
// toolcall 无身份（openai 方言首块缺 id）缓冲至 toolcall_end 补发；text/thinking_end 终态校正补发缺失尾段。

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
 *  refusal/sensitive/content_filter 与鉴权文案落无 code（不可重试）。 */
export function classifyErrorText(message: string): string | undefined {
  const lower = message.toLowerCase();
  const status = [429, 500, 502, 503, 504, 401, 403].find((code) =>
    new RegExp(`(?:^|[^0-9])${String(code)}(?:[^0-9]|$)`).test(lower),
  );
  if (status !== undefined) return `http-${String(status)}`;
  // 词边界 "refus" 覆盖 pi 真身文案 "The model refused…"（不含 "refusal" 子串），且不误伤
  // ECONNREFUSED（连接拒绝是可重试 network 错误）
  if (/\brefus/.test(lower) || lower.includes("sensitive") || lower.includes("content_filter")) return undefined;
  // 鉴权类文案落无 code（不可重试）：重试换不来新凭证
  if (lower.includes("api key") || lower.includes("authentication") || lower.includes("unauthorized") || lower.includes("permission")) {
    return undefined;
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

/** toolcall 出口适配：pi 的 toolcall_end 携带完整调用（id/name/arguments）——end 时发
 *  一帧完整 chunk（argumentsDelta = 全量 JSON 文本）；start/delta 分片不透传（x-harness
 *  无工具分片消费者——流帧只广播 text/thinking，累积器只关心最终 input）。
 *  arguments 非对象/缺席落 {}（与 pi-context parseToolInput 同口径——空参数执行防线）。 */
function toolCallChunks(event: Extract<AssistantMessageEvent, { type: "toolcall_end" }>): LlmChunk[] {
  const args = event.toolCall.arguments;
  const normalized = typeof args === "object" && args !== null && !Array.isArray(args) ? args : {};
  return [
    {
      type: "tool-call-delta",
      index: event.contentIndex,
      callId: event.toolCall.id,
      name: event.toolCall.name,
      argumentsDelta: JSON.stringify(normalized),
    },
  ];
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

/** error 终态：abort 抛 AbortError（豁免）；usage 先行；rawStopReason 判定序——
 *  ① 输出上限救回（须流内已有内容：零内容的截断错误落 ②/③错误链，防空 assistant/message
 *    与「指令对着不存在的中断」的续写）；② overflow 文本分类（`context-overflow`，优先于
 *    状态码——主力 provider 的输入溢出是 HTTP 400 + overflow 文案，落 http-400 则既不可重试
 *    也不自愈）；③ refusal/sensitive/content_filter 落无 code（不可重试）；④ 状态码在场落
 *    http-<status>；⑤ 文案分类兜底。 */
function errorChunks(event: Extract<AssistantMessageEvent, { type: "error" }>, options: PiChunkOptions, hasContent: boolean): LlmChunk[] {
  if (event.reason === "aborted" || options.signal.aborted) throw new DOMException("aborted", "AbortError");
  const chunks = [...foldUsage(event.error.usage)]; // 失败尝试已见 usage 随流落账（token-meter 计费）
  const message = event.error.errorMessage ?? "pi stream error";
  const rawStop = (event.error as { rawStopReason?: string }).rawStopReason;
  if (rawStop !== undefined && OUTPUT_LIMIT_RAW_REASONS.has(rawStop) && hasContent) {
    chunks.push({ type: "finish", finish: { kind: "max-tokens", rawReason: rawStop } });
    return chunks;
  }
  if (isContextOverflow({ ...event.error, stopReason: "error" })) { // stopReason 合成：error 事件的消息定义上即错误终态（isContextOverflow 文案分支要求该字段在场）
    chunks.push({ type: "finish", finish: { kind: "error", message, code: "context-overflow" } });
    return chunks;
  }
  const nonRetryable = rawStop === "refusal" || rawStop === "sensitive" || rawStop === "content_filter";
  const info = options.failureInfo();
  let code: string | undefined;
  if (nonRetryable) code = undefined;
  else if (info.status !== undefined) code = `http-${String(info.status)}`;
  else code = classifyErrorText(message);
  chunks.push({
    type: "finish",
    finish: {
      kind: "error",
      message,
      ...(code !== undefined ? { code } : {}),
      ...(info.retryAfterMs !== undefined ? { retryAfterMs: info.retryAfterMs } : {}),
    },
  });
  return chunks;
}

export async function* piChunks(events: AsyncIterable<AssistantMessageEvent>, options: PiChunkOptions): AsyncGenerator<LlmChunk> {
  const emittedText = new Map<number, string>(); // contentIndex → 已发 delta 拼接（终态校正用）
  let sawContent = false; // text/toolcall 已发（thinking 不计——与 loop 侧 StreamAccumulator.hasContent 同口径；error 救回的内容前置判定用）
  const state: BlockState = {
    emittedText,
    emitStartInitials: options.emitStartInitials === true,
    append: (index, delta) => {
      emittedText.set(index, (emittedText.get(index) ?? "") + delta);
    },
  };
  const iterator = events[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      const event = next.value;
      if (event.type === "done") {
        yield* foldUsage(event.message.usage);
        const raw = event.message.rawStopReason;
        yield {
          type: "finish",
          finish: event.reason === "length"
            ? { kind: "max-tokens", ...(raw !== undefined ? { rawReason: raw } : {}) }
            : { kind: "stop" },
        };
        return;
      }
      if (event.type === "error") {
        yield* errorChunks(event, options, sawContent);
        return;
      }
      if (event.type === "toolcall_end") {
        const toolChunks = toolCallChunks(event);
        sawContent = sawContent || toolChunks.length > 0;
        yield* toolChunks;
        continue;
      }
      if (event.type === "toolcall_start" || event.type === "toolcall_delta") {
        continue; // 分片不透传——end 单帧出口（见 toolCallChunks）
      }
      const chunks = blockChunks(event, state);
      sawContent = sawContent || chunks.some((chunk) => chunk.type === "text-delta");
      yield* chunks;
    }
  } finally {
    // 提前 break/throw 时尽力终止上游迭代器（fire-and-forget——pi 的 EventStream 挂在内部
    // await 时 await return() 会 pending 到下一事件；流止损靠 abort signal，见 LLM-PI.md 契约）
    void iterator.return?.(undefined as never).catch(() => {});
  }
  // 事件流自然耗尽无终态（防御层：pi 词表保证 done/error 收尾，此处兜底违约流）
  yield { type: "finish", finish: { kind: "error", message: "stream ended without finish", code: "network" } };
}
