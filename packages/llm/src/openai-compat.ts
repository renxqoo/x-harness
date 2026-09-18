// openai-compat 流式适配器（docs/LLM.md §1.3）：POST /chat/completions（SSE），
// delta.content → text-delta；delta.tool_calls 按 index 聚积分片；usage；finish_reason 三态映射。

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

/** SurfaceMessage → OpenAI 消息（user 角色仅取 text 块拼接——纲领 P14） */
function toOpenaiMessages(messages: readonly SurfaceMessage[]): OpenaiMessage[] {
  return messages.map((message): OpenaiMessage => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.text };
      case "user":
        return { role: "user", content: message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") };
      case "assistant": {
        const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        const toolCalls = message.content
          .filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use")
          .map((b): OpenaiToolCall => ({ id: b.callId, type: "function", function: { name: b.name, arguments: b.input } }));
        return toolCalls.length > 0
          ? { role: "assistant", content: text === "" ? null : text, tool_calls: toolCalls }
          : { role: "assistant", content: text };
      }
      case "tool":
        return { role: "tool", tool_call_id: message.callId, content: message.content };
    }
  });
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

/** 单帧 JSON → chunk 序列（残行/心跳跳过；finish 恰一次） */
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

export function createOpenaiCompatAdapter(options: OpenaiCompatOptions): LlmAdapter {
  const name = options.name ?? "openai-compat";
  const doFetch = options.fetch ?? fetch;
  return {
    name,
    stream: (request: LlmRequest): AsyncIterable<LlmChunk> => {
      async function* generate(): AsyncGenerator<LlmChunk> {
        request.signal.throwIfAborted();
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
        if (!response.ok || response.body === null) {
          const body = response.body === null ? "" : await response.text().catch(() => "");
          throw new Error(`llm-http-${String(response.status)}:${body.slice(0, 200)}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finishEmitted = false;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            yield* drainSseLines();
          }
        } finally {
          reader.releaseLock();
        }

        function* drainSseLines(): Generator<LlmChunk> {
          for (;;) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) return;
            const line = buffer.slice(0, newline).trimEnd();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") {
              buffer = "";
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
        }
      }
      return generate();
    },
  };
}
