// pi-context 映射（docs/LLM-PI.md 契约 2）：LlmRequest（SurfaceMessage 投影）→ pi-ai Context。
// 纯函数、零网络——两协议（anthropic-messages/openai-completions）共用同一 Context 形状。
// 语义对齐旧 anthropic-request.ts/openai-compat.ts：空 user 跳过；tool_use input STRING →
// JSON.parse 降 {}；tool 消息 toolName 由前文 assistant 的 tool_use 回查、查无落 "unknown"；
// assistant 重放元数据必填字段补齐（pi 要求 api/provider/model/usage/stopReason/timestamp）。

import type { Context, Message as PiMessage, Tool as PiTool, ToolCall } from "@earendil-works/pi-ai";
import type { TextContent, ThinkingContent } from "@earendil-works/pi-ai";
import type { SurfaceMessage } from "@x-harness/session";
import type { ToolSchema } from "@x-harness/tools";
import type { LlmRequest } from "./types.ts";

/** tool_use input：parse 失败或非 plain object（null/数组/原始值）→ {}——pi ToolCall 要对象，垃圾不崩 */
function parseToolInput(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* 降级 {} */
  }
  return {};
}

function textBlocksOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null) {
      const record = block as Record<string, unknown>;
      if (record["type"] === "text" && typeof record["text"] === "string" && record["text"] !== "") texts.push(record["text"]);
    }
  }
  return texts;
}

/** assistant 块整形：text → TextContent；tool_use → ToolCall（input 解析降 {}） */
function assistantContent(content: unknown, api: string, modelId: string): Array<TextContent | ThinkingContent | ToolCall> {
  const out: Array<TextContent | ThinkingContent | ToolCall> = [];
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string" && record["text"] !== "") {
      out.push({ type: "text", text: record["text"] });
    }
    const callId = record["callId"];
    const name = record["name"];
    const input = record["input"];
    if (record["type"] === "tool_use" && typeof callId === "string" && typeof name === "string" && typeof input === "string") {
      out.push({ type: "toolCall", id: callId, name, arguments: parseToolInput(input) });
    }
  }
  void api;
  void modelId;
  return out;
}

/** SurfaceMessage → pi wire 消息（空 user 整条跳过；toolName 前文回查） */
export function toPiMessages(
  messages: readonly SurfaceMessage[],
  meta: { readonly api: string; readonly provider: string; readonly model: string },
): PiMessage[] {
  const out: PiMessage[] = [];
  const nameByCallId = new Map<string, string>(); // 前文 assistant tool_use 的 callId → name 回查
  for (const message of messages) {
    switch (message.role) {
      case "system":
        break; // systemPrompt 收集归调用方
      case "user": {
        const texts = textBlocksOf(message.content);
        if (texts.length === 0) continue; // 空 user 整条跳过（垃圾降级，不换 400）
        out.push({
          role: "user",
          content: texts.map((text) => ({ type: "text" as const, text })),
          timestamp: 0,
        });
        break;
      }
      case "assistant": {
        const content = assistantContent(message.content, meta.api, meta.model);
        if (content.length === 0) continue;
        for (const block of content) {
          if (block.type === "toolCall") nameByCallId.set(block.id, block.name);
        }
        out.push({
          role: "assistant",
          content,
          api: meta.api as never,
          provider: meta.provider as never,
          model: meta.model,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: 0,
        });
        break;
      }
      case "tool": {
        out.push({
          role: "toolResult",
          toolCallId: message.callId,
          toolName: nameByCallId.get(message.callId) ?? "unknown",
          content: [{ type: "text", text: message.content ?? "" }],
          isError: message.isError === true,
          timestamp: 0,
        });
        break;
      }
    }
  }
  return out;
}

function toPiTools(tools: readonly ToolSchema[]): PiTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "", // pi Tool.description 必填——缺席落空串
    parameters: tool.inputSchema as PiTool["parameters"],
  }));
}

export function toPiContext(
  request: LlmRequest,
  meta: { readonly api: string; readonly provider: string; readonly model: string },
): Context {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => (message as { text?: string }).text ?? "")
    .filter((text) => text !== "")
    .join("\n\n");
  return {
    ...(system !== "" ? { systemPrompt: system } : {}),
    messages: toPiMessages(request.messages, meta),
    ...(request.tools.length > 0 ? { tools: toPiTools(request.tools) } : {}),
  };
}
