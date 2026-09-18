// openai-compat 流式适配器（docs/LLM.md §1.4）：POST /chat/completions（SSE）。
// 行扫描/拨号/失败映射走共享底座（sse-scan/http-dial）；本文件只装 OpenAI 协议知识：
// 帧结构（choices/delta/usage/finish_reason）、[DONE] 终止符、消息与工具表转换。

import { dial } from "./http-dial.ts";
import { scanDataFrames } from "./sse-scan.ts";
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

export function createOpenaiCompatAdapter(options: OpenaiCompatOptions): LlmAdapter {
  const name = options.name ?? "openai-compat";
  const doFetch = options.fetch ?? fetch;
  return {
    name,
    stream: (request: LlmRequest): AsyncIterable<LlmChunk> => {
      async function* generate(): AsyncGenerator<LlmChunk> {
        request.signal.throwIfAborted();
        const sent = await dial({
          url: `${options.baseUrl}/chat/completions`,
          headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
          body: {
            model: request.model,
            messages: toOpenaiMessages(request.messages),
            ...(request.tools.length > 0 ? { tools: toOpenaiTools(request.tools) } : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
            stream: true,
            stream_options: { include_usage: true },
          },
          signal: request.signal,
          fetch: doFetch,
        });
        if ("failure" in sent) {
          yield sent.failure;
          return;
        }
        let finishEmitted = false;
        let sawDone = false;
        try {
          for await (const payload of scanDataFrames(sent.response.body as ReadableStream<Uint8Array>, {
            isTerminator: (frame) => {
              if (frame === "[DONE]") {
                sawDone = true;
                return true;
              }
              return false;
            },
          })) {
            yield* chunksFromFrame(
              payload,
              () => finishEmitted,
              () => {
                finishEmitted = true;
              },
            );
          }
          if (!finishEmitted && !sawDone) {
            // 截断流（服务端关连接/代理截断——无 [DONE] 无 finish_reason）：归网络类可重试
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
