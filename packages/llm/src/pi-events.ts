// pi-events 映射（docs/LLM-PI.md 契约 2）：pi AssistantMessageEvent → LlmChunk。
// 终态恰一次（done/error 后停发）；abort 豁免（reason aborted / signal 已断 → throw AbortError，
// 对齐 runtime isAbortLike）；error 事件先发 usage（error.usage 折算——失败尝试计费）再发 error finish；
// P10 初值：text/thinking_start 时 partial.content[contentIndex] 非空初值补发 delta；
// toolcall 无身份（openai 首块缺 id 方言）缓冲至 toolcall_end 补发 start+全量。

import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ContentBlock } from "@earendil-works/pi-ai";
import type { LlmChunk, LlmFinish, TokenUsage } from "./types.ts";

/** usage 折算（docs/LLM-PI.md 契约 4）：cacheRead+cacheWrite 并入 input——GLM 桥自动缓存不低计；全零不发 */
export function foldUsage(usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined): LlmChunk[] {
  if (usage === undefined) return [];
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  if (input === 0 && usage.output === 0) return []; // 空快照守卫：缺报后端全零不产噪音帧
  return [{ type: "usage", usage: { input, output: usage.output } satisfies TokenUsage }];
}

/** partial.content[index] 上的文本/思考初值（P10：pi 的 start 事件带块身份但初值不产 delta） */
function initialTextAt(partial: { content?: unknown } | undefined, index: number, kind: "text" | "thinking"): string | undefined {
  const block = Array.isArray(partial?.content) ? (partial?.content as ContentBlock[])[index] : undefined;
  if (typeof block !== "object" || block === null) return undefined;
  const record = block as Record<string, unknown>;
  if (kind === "text" && record["type"] === "text" && typeof record["text"] === "string" && record["text"] !== "") {
    return record["text"];
  }
  if (kind === "thinking" && record["type"] === "thinking" && typeof record["thinking"] === "string" && record["thinking"] !== "") {
    return record["thinking"];
  }
  return undefined;
}

/** partial.content[index] 上的 ToolCall 身份（start 可能缺——openai 方言首块无 id） */
function toolCallAt(partial: { content?: unknown } | undefined, index: number): { id: string; name: string } | undefined {
  const block = Array.isArray(partial?.content) ? (partial?.content as ContentBlock[])[index] : undefined;
  if (typeof block !== "object" || block === null) return undefined;
  const record = block as Record<string, unknown>;
  if (record["type"] !== "toolCall") return undefined;
  const id = record["id"];
  const name = record["name"];
  if (typeof id === "string" && typeof name === "string") return { id, name };
  return undefined;
}

/** 错误文案分类（onResponse 缺席时的兜底；状态码在场时优先用 http-<status>——见 pi-adapter）。
 *  词边界匹配防数值子串误杀（"used 14290 tokens" ≠ 429）；refusal/sensitive/content_filter
 *  落无 code（不可重试——与旧 refusal 行为一致）。 */
export function classifyErrorText(message: string): string | undefined {
  const lower = message.toLowerCase();
  if (lower.includes("refusal") || lower.includes("sensitive") || lower.includes("content_filter")) return undefined;
  const status = [429, 500, 502, 503, 504, 401, 403].find((code) =>
    new RegExp(`(?:^|[^0-9])${String(code)}(?:[^0-9]|$)`).test(lower),
  );
  if (status !== undefined) return `http-${String(status)}`;
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
  /** 拨号上下文快照（onResponse 捕获）：状态码在场时 error 落 http-<status>；retry-after 头毫秒 */
  readonly failureInfo: () => { status?: number; retryAfterMs?: number };
}

export async function* piChunks(events: AsyncIterable<AssistantMessageEvent>, options: PiChunkOptions): AsyncGenerator<LlmChunk> {
  const { signal } = options;
  const idByIndex = new Map<number, string>();
  const pendingDeltas = new Map<number, string[]>();
  for (;;) {
    const next = await events[Symbol.asyncIterator]().next();
    if (next.done === true) break;
    const event = next.value;
    switch (event.type) {
      case "text_start": {
        const initial = initialTextAt(event.partial, event.contentIndex, "text");
        if (initial !== undefined) yield { type: "text-delta", text: initial };
        break;
      }
      case "thinking_start": {
        const initial = initialTextAt(event.partial, event.contentIndex, "thinking");
        if (initial !== undefined) yield { type: "thinking-delta", text: initial };
        break;
      }
      case "text_delta":
        if (event.delta !== "") yield { type: "text-delta", text: event.delta };
        break;
      case "thinking_delta":
        if (event.delta !== "") yield { type: "thinking-delta", text: event.delta };
        break;
      case "toolcall_start": {
        const call = toolCallAt(event.partial, event.contentIndex);
        if (call !== undefined) {
          idByIndex.set(event.contentIndex, call.id);
          yield { type: "tool-call-delta", index: event.contentIndex, callId: call.id, name: call.name };
        } else {
          pendingDeltas.set(event.contentIndex, []); // 身份未定：缓冲至 end 补发
        }
        break;
      }
      case "toolcall_delta": {
        if (idByIndex.has(event.contentIndex)) {
          yield { type: "tool-call-delta", index: event.contentIndex, argumentsDelta: event.delta };
        } else {
          pendingDeltas.get(event.contentIndex)?.push(event.delta);
        }
        break;
      }
      case "toolcall_end": {
        const buffered = pendingDeltas.get(event.contentIndex);
        if (buffered === undefined) break; // 身份已在 start 发出，分片已流式
        pendingDeltas.delete(event.contentIndex);
        idByIndex.set(event.contentIndex, event.toolCall.id);
        yield { type: "tool-call-delta", index: event.contentIndex, callId: event.toolCall.id, name: event.toolCall.name };
        const joined = buffered.join("");
        if (joined !== "") yield { type: "tool-call-delta", index: event.contentIndex, argumentsDelta: joined };
        break;
      }
      case "done": {
        yield* foldUsage(event.message.usage);
        const finish: LlmFinish = event.reason === "length" ? { kind: "max-tokens" } : { kind: "stop" };
        yield { type: "finish", finish };
        return;
      }
      case "error": {
        if (event.reason === "aborted" || signal.aborted) throw new DOMException("aborted", "AbortError");
        yield* foldUsage(event.error.usage); // 失败尝试已见 usage 随流落账（token-meter 计费）
        const info = options.failureInfo();
        const code = info.status !== undefined ? `http-${String(info.status)}` : classifyErrorText(event.error.errorMessage ?? "pi stream error");
        yield {
          type: "finish",
          finish: {
            kind: "error",
            message: event.error.errorMessage ?? "pi stream error",
            ...(code !== undefined ? { code } : {}),
            ...(info.retryAfterMs !== undefined ? { retryAfterMs: info.retryAfterMs } : {}),
          },
        };
        return;
      }
      default:
        break; // 未知事件跳过（防御层——pi 词表外的兼容）
    }
  }
  // 事件流自然耗尽无终态（防御层：pi 词表保证 done/error 收尾，此处兜底违约流）
  yield { type: "finish", finish: { kind: "error", message: "stream ended without finish", code: "network" } };
}
