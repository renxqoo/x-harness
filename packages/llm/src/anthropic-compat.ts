// anthropic-compat 流式适配器（docs/LLM.md §1.5）：POST /v1/messages（Anthropic Messages SSE）。
// 行扫描/拨号走共享底座；本文件只装 Anthropic 协议知识：事件分派（message_start/blocks/delta/
// message_delta/message_stop）、stop_reason 全集映射、usage 快照随事件即发（cache 桶并入 input）。

import { dial } from "./http-dial.ts";
import { scanDataFrames } from "./sse-scan.ts";
import { toAnthropicRequest } from "./anthropic-request.ts";
import type { LlmAdapter, LlmChunk, LlmFinish, LlmRequest } from "./types.ts";

export interface AnthropicCompatOptions {
  readonly name?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  /** 仅 request.maxTokens 缺席时使用（协议必填的缺省上限逃生位） */
  readonly maxTokensDefault?: number;
}

interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

interface AnthropicEvent {
  readonly type?: string;
  readonly index?: number;
  readonly message?: { readonly usage?: AnthropicUsage };
  readonly content_block?: { readonly type?: string; readonly text?: string; readonly thinking?: string; readonly id?: string; readonly name?: string };
  readonly delta?: { readonly type?: string; readonly text?: string; readonly thinking?: string; readonly partial_json?: string; readonly stop_reason?: string; readonly stop_details?: { readonly explanation?: string } };
  readonly usage?: AnthropicUsage;
  readonly error?: { readonly type?: string; readonly message?: string };
}

/** usage 快照（cache 桶并入 input——GLM 桥自动缓存不低计）；字段级替换（P8：字段缺席保留旧值——
 *  代理只回 output 不归零 input；字段在场以新值替换，避免 message_start/delta 双计） */
interface UsageState {
  input: number | undefined;
  output: number | undefined;
}

/** 单帧 usage 的 input 侧 = input_tokens + cache_read + cache_creation（缺席桶跳过） */
function foldedInput(usage: AnthropicUsage): number | undefined {
  let sum: number | undefined;
  for (const value of [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]) {
    if (count(value)) sum = (sum ?? 0) + value;
  }
  return sum;
}

function mergeUsage(state: UsageState, usage: AnthropicUsage | undefined): LlmChunk[] {
  if (usage === undefined) return [];
  const input = foldedInput(usage);
  if (input !== undefined) state.input = input;
  if (count(usage.output_tokens)) state.output = usage.output_tokens;
  const snapshot: { input?: number; output?: number } = {};
  if (state.input !== undefined) snapshot.input = state.input;
  if (state.output !== undefined) snapshot.output = state.output;
  if (snapshot.input === undefined && snapshot.output === undefined) return []; // 空快照不发噪音帧
  return [{ type: "usage", usage: snapshot }];
}

/** stop_reason 全集：refusal/sensitive → error finish；未知 → stop（fail-open 落档） */
function mapStopReason(reason: string, details: { readonly explanation?: string }): LlmFinish {
  if (reason === "max_tokens") return { kind: "max-tokens" };
  if (reason === "refusal" || reason === "sensitive") {
    return { kind: "error", message: details.explanation ?? reason };
  }
  return { kind: "stop" }; // end_turn / tool_use / stop_sequence / pause_turn / 未知
}

interface EventState {
  readonly usage: UsageState;
  finishEmitted: boolean;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** content_block_start → 块身份 chunk（text/thinking 初值不丢 P10；tool_use 身份带稀疏 index 原值；未知块跳过） */
function blockStartChunks(event: AnthropicEvent): LlmChunk[] {
  const block = event.content_block;
  if (block?.type === "text" && typeof block.text === "string" && block.text !== "") {
    return [{ type: "text-delta", text: block.text }];
  }
  if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking !== "") {
    return [{ type: "thinking-delta", text: block.thinking }];
  }
  if (block?.type === "tool_use" && typeof block.id === "string" && count(event.index)) {
    return [{ type: "tool-call-delta", index: event.index, callId: block.id, ...(block.name !== undefined ? { name: block.name } : {}) }];
  }
  return [];
}

/** content_block_delta → 增量 chunk（text/thinking/input_json；signature/未知 delta 跳过；空文本跳过） */
function blockDeltaChunks(event: AnthropicEvent): LlmChunk[] {
  const delta = event.delta;
  if (!count(event.index)) return [];
  if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") {
    return [{ type: "text-delta", text: delta.text }];
  }
  if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking !== "") {
    return [{ type: "thinking-delta", text: delta.thinking }];
  }
  if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
    return [{ type: "tool-call-delta", index: event.index, argumentsDelta: delta.partial_json }];
  }
  return [];
}

function errorChunks(event: AnthropicEvent, state: EventState): LlmChunk[] {
  if (state.finishEmitted) return []; // finish 已发：error 不翻盘（恰一次守卫）
  state.finishEmitted = true;
  const kind = event.error?.type;
  const message = event.error?.message ?? kind ?? "anthropic error";
  // overloaded_error 是瞬时过载（无 HTTP status）→ 归 network 进重试闭集；其余 type 落 message
  const finish: LlmFinish = kind === "overloaded_error" ? { kind: "error", message, code: "network" } : { kind: "error", message };
  return [{ type: "finish", finish }];
}

function messageDeltaChunks(event: AnthropicEvent, state: EventState): LlmChunk[] {
  const chunks: LlmChunk[] = [...mergeUsage(state.usage, event.usage)]; // usage 先于 finish（与 openai 帧内序一致）
  const stop = event.delta?.stop_reason;
  if (typeof stop === "string" && !state.finishEmitted) {
    state.finishEmitted = true;
    chunks.push({ type: "finish", finish: mapStopReason(stop, { explanation: event.delta?.stop_details?.explanation }) });
  }
  return chunks;
}

/** 单事件 → chunk 序列（不可解析帧跳过；ping/content_block_stop/未知事件跳过） */
function chunksFromEvent(frame: string, state: EventState): LlmChunk[] {
  let event: AnthropicEvent;
  try {
    event = JSON.parse(frame) as AnthropicEvent;
  } catch {
    return [];
  }
  switch (event.type) {
    case "message_start":
      return mergeUsage(state.usage, event.message?.usage);
    case "content_block_start":
      return blockStartChunks(event);
    case "content_block_delta":
      return blockDeltaChunks(event);
    case "message_delta":
      return messageDeltaChunks(event, state);
    case "error":
      return errorChunks(event, state);
    default:
      return [];
  }
}

export function createAnthropicCompatAdapter(options: AnthropicCompatOptions): LlmAdapter {
  const name = options.name ?? "anthropic-compat";
  const doFetch = options.fetch ?? fetch;
  return {
    name,
    stream: (request: LlmRequest): AsyncIterable<LlmChunk> => {
      async function* generate(): AsyncGenerator<LlmChunk> {
        request.signal.throwIfAborted();
        const sent = await dial({
          url: `${options.baseUrl}/v1/messages`,
          headers: { "content-type": "application/json", "x-api-key": options.apiKey, "anthropic-version": "2023-06-01" },
          body: toAnthropicRequest(request, options.maxTokensDefault),
          signal: request.signal,
          fetch: doFetch,
        });
        if ("failure" in sent) {
          yield sent.failure;
          return;
        }
        const state: EventState = { usage: { input: undefined, output: undefined }, finishEmitted: false };
        let sawStop = false;
        try {
          for await (const payload of scanDataFrames(sent.response.body as ReadableStream<Uint8Array>, {
            isTerminator: (frame) => {

              try {
                if ((JSON.parse(frame) as { type?: string }).type === "message_stop") {
                  sawStop = true;
                  return true;
                }
              } catch {
                /* 非 JSON 帧不可能是终止符 */
              }
              return false;
            },
          })) {
            yield* chunksFromEvent(payload, state);
          }
          if (!state.finishEmitted && !sawStop) {
            // EOF 未见 message_stop 且无 finish：截断流归网络类可重试（usage 已随事件即发，不丢）
            yield { type: "finish", finish: { kind: "error", message: "stream ended without finish", code: "network" } };
          }
        } catch (error) {
          if (request.signal.aborted) throw error; // abort 豁免
          const message = error instanceof Error ? error.message : String(error);
          yield { type: "finish", finish: { kind: "error", message, code: "network" } };
        }
      }
      return generate();
    },
  };
}
