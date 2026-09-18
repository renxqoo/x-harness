// openai-compat 流式适配器（docs/LLM.md §1.4）：POST /chat/completions（SSE）。
// 失败契约：abort throw；连接/HTTP/读体/截断 → finish{error, code} 收尾（code 词表 http-<status>/network）；
// SSE 硬化：行缓冲跨 read 拼接、多字节防撕裂、EOF 残量终 flush、CRLF/注释行/event: 行跳过、
// [DONE] 停读释连接、finish 恰一次守卫（usage 帧可在 finish 后到达）。

import type { LlmAdapter, LlmChunk, LlmFinish, LlmRequest } from "./types.ts";
import type { SurfaceMessage } from "@x-harness/session";
import type { ToolSchema } from "@x-harness/tools";

export interface OpenaiCompatOptions {
  readonly name?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
}

type OpenaiMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string | null; readonly tool_calls?: OpenaiToolCall[] }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

interface OpenaiToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

/** SurfaceMessage → OpenAI 消息（user 角色仅取 text 块拼接——纲领 P14；畸形输入降级不崩） */
function toOpenaiMessages(messages: readonly SurfaceMessage[]): OpenaiMessage[] {
  return messages.map((message): OpenaiMessage => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.text ?? "" };
      case "user":
        return { role: "user", content: textOf(message.content).join("\n") };
      case "assistant": {
        const parts = blocksOf(message.content);
        const text = parts.texts.join("");
        const toolCalls = parts.toolUses.map(
          (b): OpenaiToolCall => ({ id: b.callId, type: "function", function: { name: b.name, arguments: b.input } }),
        );
        return toolCalls.length > 0
          ? { role: "assistant", content: text === "" ? null : text, tool_calls: toolCalls }
          : { role: "assistant", content: text };
      }
      case "tool":
        return { role: "tool", tool_call_id: message.callId, content: message.content ?? "" };
    }
  });
}

/** 块整形：只认 text/tool_use（其余块跳过）；content 缺席归一空——垃圾投影不崩（P16 语义） */
function blocksOf(content: unknown): { texts: string[]; toolUses: Array<{ callId: string; name: string; input: string }> } {
  const texts: string[] = [];
  const toolUses: Array<{ callId: string; name: string; input: string }> = [];
  if (!Array.isArray(content)) return { texts, toolUses };
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string") texts.push(record["text"]);
    if (
      record["type"] === "tool_use" &&
      typeof record["callId"] === "string" &&
      typeof record["name"] === "string" &&
      typeof record["input"] === "string"
    ) {
      toolUses.push({ callId: record["callId"], name: record["name"], input: record["input"] });
    }
  }
  return { texts, toolUses };
}

function textOf(content: unknown): string[] {
  return blocksOf(content).texts;
}

function toOpenaiTools(tools: readonly ToolSchema[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: tool.inputSchema, // TypeBox schema 序列化自动丢符号修饰键（纯 JSON Schema）
    },
  }));
}

function mapFinishReason(reason: string | null | undefined): LlmFinish {
  if (reason === "length") return { kind: "max-tokens" };
  return { kind: "stop" }; // stop / tool_calls / 未知一律 stop
}

interface SseDelta {
  readonly content?: string;
  readonly tool_calls?: Array<{
    readonly index: number;
    readonly id?: string;
    readonly function?: { readonly name?: string; readonly arguments?: string };
  }>;
}

interface SseChunk {
  readonly choices?: Array<{ readonly delta?: SseDelta; readonly finish_reason?: string | null }>;
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
}

function textChunk(delta: SseDelta | undefined): LlmChunk[] {
  if (delta?.content === undefined || delta.content === "") return [];
  return [{ type: "text-delta", text: delta.content }];
}

function toolCallChunks(delta: SseDelta | undefined): LlmChunk[] {
  return (delta?.tool_calls ?? []).map((call) => ({
    type: "tool-call-delta" as const,
    index: call.index,
    ...(call.id !== undefined ? { callId: call.id } : {}),
    ...(call.function?.name !== undefined ? { name: call.function.name } : {}),
    ...(call.function?.arguments !== undefined ? { argumentsDelta: call.function.arguments } : {}),
  }));
}

function usageChunk(chunk: SseChunk): LlmChunk[] {
  if (chunk.usage === undefined) return [];
  return [
    {
      type: "usage",
      usage: {
        ...(chunk.usage.prompt_tokens !== undefined ? { input: chunk.usage.prompt_tokens } : {}),
        ...(chunk.usage.completion_tokens !== undefined ? { output: chunk.usage.completion_tokens } : {}),
      },
    },
  ];
}

/** 单帧 JSON → chunk 序列（不可解析帧跳过；finish 恰一次守卫） */
function chunksFromFrame(frame: string, finished: () => boolean, markFinished: () => void): LlmChunk[] {
  let chunk: SseChunk;
  try {
    chunk = JSON.parse(frame) as SseChunk;
  } catch {
    return [];
  }
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  const finishReason = choice?.finish_reason;
  const finish =
    finishReason !== null && finishReason !== undefined && !finished()
      ? (markFinished(), [{ type: "finish" as const, finish: mapFinishReason(finishReason) }])
      : [];
  return [...textChunk(delta), ...toolCallChunks(delta), ...usageChunk(chunk), ...finish];
}

/** Retry-After：秒（含小数）→ 毫秒；HTTP-date → 相对毫秒（过去=0 立即）；不可解析 → undefined（缺席） */
function retryAfterMs(header: string | null, now: () => number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - now());
}

type Sent = { readonly response: Response } | { readonly failure: LlmChunk };

/** 拨号段：请求体构造 + fetch + 连接失败/非 2xx 映射（abort 豁免透传） */
async function sendRequest(options: OpenaiCompatOptions, doFetch: typeof fetch, request: LlmRequest): Promise<Sent> {
  try {
    const response = await doFetch(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({
        model: request.model,
        messages: toOpenaiMessages(request.messages),
        ...(request.tools.length > 0 ? { tools: toOpenaiTools(request.tools) } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: request.signal,
    });
    if (response.ok && response.body !== null) return { response };
    const body = response.body === null ? "" : await response.text().catch(() => "");
    const status = String(response.status);
    const retry = response.status === 429 || response.status === 503 ? retryAfterMs(response.headers.get("retry-after"), Date.now) : undefined;
    return {
      failure: {
        type: "finish",
        finish: {
          kind: "error",
          message: body.slice(0, 200), // code 已携带状态；message 只给体摘要
          code: `http-${status}`,
          ...(retry !== undefined ? { retryAfterMs: retry } : {}),
        },
      },
    };
  } catch (error) {
    if (request.signal.aborted) throw error; // abort 豁免：透传 AbortError
    return { failure: { type: "finish", finish: { kind: "error", message: errorMessage(error), code: "network" } } };
  }
}

export function createOpenaiCompatAdapter(options: OpenaiCompatOptions): LlmAdapter {
  const name = options.name ?? "openai-compat";
  const doFetch = options.fetch ?? fetch;
  return {
    name,
    stream: (request: LlmRequest): AsyncIterable<LlmChunk> => {
      async function* generate(): AsyncGenerator<LlmChunk> {
        request.signal.throwIfAborted();
        const sent = await sendRequest(options, doFetch, request);
        if ("failure" in sent) {
          yield sent.failure;
          return;
        }
        const response = sent.response;
        const body = response.body as ReadableStream<Uint8Array>; // sendRequest 已保证非空
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finishEmitted = false;
        let doneReceived = false;
        try {
          for (;;) {
            const read = await reader.read();
            if (read.done) break;
            buffer += decoder.decode(read.value, { stream: true });
            yield* drainSseLines();
            if (doneReceived) break; // [DONE] = 终止符：停读（trailing 数据不混入）
          }
          buffer += decoder.decode(); // EOF 终 flush：多字节残量解码
          if (buffer.length > 0 && !doneReceived) yield* drainFinalLine();
          if (!finishEmitted && !doneReceived) {
            // 截断流（服务端关连接/代理截断——无 [DONE] 无 finish_reason）：归网络类可重试
            yield { type: "finish", finish: { kind: "error", message: "stream ended without finish", code: "network" } };
          }
        } catch (error) {
          if (request.signal.aborted) throw error; // abort 豁免
          yield { type: "finish", finish: { kind: "error", message: errorMessage(error), code: "network" } };
        } finally {
          // 先 cancel 再释放锁：releaseLock 后 cancel 是无效调用（流不被取消、连接悬挂）
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }

        function* processLine(line: string): Generator<LlmChunk> {
          if (line.startsWith(":")) return; // SSE 注释行
          if (!line.startsWith("data:")) return; // event:/id:/空行等跳过
          const payload = line.slice(5).trim();
          if (payload === "") return;
          if (payload === "[DONE]") {
            buffer = "";
            doneReceived = true;
            return;
          }
          yield* chunksFromFrame(
            payload,
            () => finishEmitted,
            () => {
              finishEmitted = true;
            },
          );
        }

        function* drainSseLines(): Generator<LlmChunk> {
          for (;;) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) return;
            const line = buffer.slice(0, newline).trimEnd(); // CRLF 由 trimEnd 吸收
            buffer = buffer.slice(newline + 1);
            yield* processLine(line);
            if (doneReceived) return;
          }
        }

        /** EOF 残量（无尾换行的最后一帧）按整行处理——半行帧不丢 */
        function* drainFinalLine(): Generator<LlmChunk> {
          const line = buffer.trimEnd();
          buffer = "";
          if (line === "") return;
          yield* processLine(line);
        }
      }
      return generate();
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
