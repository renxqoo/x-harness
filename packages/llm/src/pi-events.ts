import { isContextOverflow, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { LlmChunk, TokenUsage } from "./types.ts";

export function foldUsage(usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number; cost?: import("./types.ts").UsageCost } | undefined): LlmChunk[] {
  if (usage === undefined) return [];
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  if (input === 0 && usage.output === 0) return [];
  return [{
    type: "usage",
    usage: {
      input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
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

export function classifyErrorText(message: string): string {
  const lower = message.toLowerCase();
  const status = [429, 500, 502, 503, 504, 401, 403].find((code) =>
    new RegExp(`(?:^|[^0-9])${String(code)}(?:[^0-9]|$)`).test(lower),
  );
  if (status !== undefined) return `http-${String(status)}`;
  if (/\brefus/.test(lower) || lower.includes("sensitive") || lower.includes("content_filter")) return "non-retryable";
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
  return "network";
}

export interface PiChunkOptions {
  readonly signal: AbortSignal;
  readonly failureInfo: () => { status?: number; retryAfterMs?: number };
}

function missingTail(content: string, emitted: string): string {
  if (emitted === "") return content;
  if (content.startsWith(emitted)) return content.slice(emitted.length);
  if (content.endsWith(emitted)) return content.slice(0, content.length - emitted.length);
  return "";
}

interface ToolCallState {
  readonly rawArgs: Map<number, string>;
  readonly identity: Map<number, { callId: string; name: string }>;
  readonly pending: Map<number, { callId: string; name: string; args: unknown }>;
  readonly emitted: Set<number>;
  appendRaw(index: number, delta: string): void;
  noteIdentity(event: Extract<AssistantMessageEvent, { type: "toolcall_start" }>): void;
  holdEnd(event: Extract<AssistantMessageEvent, { type: "toolcall_end" }>): void;
}

function identityAt(partial: { content?: unknown } | undefined, index: number): { callId: string; name: string } | undefined {
  const block = blockAt(partial, index);
  if (block === undefined || block["type"] !== "toolCall") return undefined;
  const callId = block["id"];
  const name = block["name"];
  return typeof callId === "string" && typeof name === "string" ? { callId, name } : undefined;
}

function holdEndChunks(event: Extract<AssistantMessageEvent, { type: "toolcall_end" }>): { callId: string; name: string; args: unknown } {
  const args = event.toolCall.arguments;
  return { callId: event.toolCall.id, name: event.toolCall.name, args: typeof args === "object" && args !== null && !Array.isArray(args) ? args : {} };
}

function argumentsDeltaFor(raw: string | undefined, normalized: unknown): string {
  if (raw === undefined) return JSON.stringify(normalized);
  if (raw === "") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  return JSON.stringify(normalized !== undefined ? normalized : parsed);
}

function pendingChunkAt(index: number, held: { callId: string; name: string; args: unknown }, raw: string | undefined): LlmChunk {
  return {
    type: "tool-call-delta",
    index,
    callId: held.callId,
    name: held.name,
    argumentsDelta: argumentsDeltaFor(raw, held.args),
  };
}

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
  append(index: number, delta: string): void;
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
  if (event.type === "text_start" || event.type === "thinking_start") return [];
  if (event.type === "text_delta" || event.type === "thinking_delta") return deltaChunks(event, state, kind);
  if (event.type === "text_end") return endChunks(event, state, "text");
  if (event.type === "thinking_end") {
    const chunks = endChunks(event, state, "thinking");
    const signature = signatureAt(event.partial, event.contentIndex);
    if (signature === undefined) return chunks;
    return [...chunks, signature];
  }
  return [];
}

function signatureAt(partial: unknown, contentIndex: number): { type: "thinking-signature"; signature: string; redacted: boolean } | undefined {
  if (typeof partial !== "object" || partial === null) return undefined;
  const content = (partial as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const block = content[contentIndex];
  if (typeof block !== "object" || block === null) return undefined;
  const record = block as { thinkingSignature?: unknown; redacted?: unknown };
  if (typeof record.thinkingSignature !== "string" || record.thinkingSignature === "") return undefined;
  return { type: "thinking-signature", signature: record.thinkingSignature, redacted: record.redacted === true };
}

const OUTPUT_LIMIT_RAW_REASONS: ReadonlySet<string> = new Set(["max_tokens", "max_output_tokens", "model_context_window_exceeded"]);

function outputLimitFinish(rawStop: string | undefined, hasContent: boolean, message: string): LlmChunk | undefined {
  if (rawStop === undefined || !OUTPUT_LIMIT_RAW_REASONS.has(rawStop)) return undefined;
  if (hasContent) return { type: "finish", finish: { kind: "max-tokens", rawReason: rawStop } };
  return { type: "finish", finish: { kind: "error", message, code: "context-overflow" } };
}

function errorChunks(event: Extract<AssistantMessageEvent, { type: "error" }>, options: PiChunkOptions, hasContent: boolean): LlmChunk[] {
  if (event.reason === "aborted" || options.signal.aborted) throw new DOMException("aborted", "AbortError");
  const chunks = [...foldUsage(event.error.usage)];
  const message = event.error.errorMessage ?? "pi stream error";
  const rawStop = (event.error as { rawStopReason?: string }).rawStopReason;
  const info = options.failureInfo();
  const rescued = outputLimitFinish(rawStop, hasContent, message);
  if (rescued !== undefined) {
    chunks.push(rescued);
    return chunks;
  }
  if (isContextOverflow({ ...event.error, stopReason: "error" })) {
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

function doneFinish(message: { usage?: { output?: number }; rawStopReason?: string }, reason: string): LlmChunk {
  if (reason !== "length") return { type: "finish", finish: { kind: "stop" } };
  if ((message.usage?.output ?? -1) === 0) {
    return { type: "finish", finish: { kind: "error", message: "length stop with zero output (context window overflow)", code: "context-overflow" } };
  }
  const raw = message.rawStopReason;
  return { type: "finish", finish: { kind: "max-tokens", ...(raw !== undefined ? { rawReason: raw } : {}) } };
}

export async function* piChunks(events: AsyncIterable<AssistantMessageEvent>, options: PiChunkOptions): AsyncGenerator<LlmChunk> {
  const emittedText = new Map<number, string>();
  let sawContent = false;
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
    append: (index, delta) => {
      emittedText.set(index, (emittedText.get(index) ?? "") + delta);
    },
  };
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
        const synthesized = synthesizeMissingChunks(toolState);
        sawContent = sawContent || synthesized.length > 0;
        yield* synthesized;
        yield doneFinish(event.message, event.reason);
        return;
      }
      if (event.type === "error") {
        yield* flushPending();
        const synthesized = synthesizeMissingChunks(toolState);
        sawContent = sawContent || synthesized.length > 0;
        yield* synthesized;
        yield* errorChunks(event, options, sawContent);
        return;
      }
      if (event.type === "toolcall_end") {
        const held = holdEndChunks(event);
        toolState.emitted.add(event.contentIndex);
        sawContent = true;
        yield pendingChunkAt(event.contentIndex, held, toolState.rawArgs.get(event.contentIndex));
        continue;
      }
      if (event.type === "toolcall_start") {
        toolState.noteIdentity(event);
        continue;
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
    yield* flushPending();
    yield* synthesizeMissingChunks(toolState);
    throw error;
  } finally {
    yield* flushPending();
    yield* synthesizeMissingChunks(toolState);
    void iterator.return?.(undefined as never).catch(() => {});
  }
  yield { type: "finish", finish: { kind: "error", message: "stream ended without finish", code: "network" } };
}
