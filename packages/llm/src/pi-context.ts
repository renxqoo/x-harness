// pi-context 映射（docs/LLM-PI.md 契约 2）：LlmRequest（SurfaceMessage 投影）→ pi-ai Context。
// 纯函数、零网络——两协议（anthropic-messages/openai-completions）共用同一 Context 形状。
// 语义对齐旧 anthropic-request.ts/openai-compat.ts：空 user 跳过；tool_use input STRING →
// JSON.parse 降 {}；tool 消息 toolName 由前文 assistant 的 tool_use 回查、查无落 "unknown"；
// assistant 重放元数据必填字段补齐（pi 要求 api/provider/model/usage/stopReason/timestamp）。

import type { Context, Message as PiMessage, Tool as PiTool, ToolCall } from "@earendil-works/pi-ai";
import type { ImageContent, TextContent, ThinkingContent } from "@earendil-works/pi-ai";
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

/** user 块整形：text（非空）→ TextContent；image → ImageContent（mediaType 换名 mimeType——
 *  内核字段名对齐 hub wire，pi 侧换名收敛于此单点） */
function userContent(content: unknown): Array<TextContent | ImageContent> {
  const out: Array<TextContent | ImageContent> = [];
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string" && record["text"] !== "") {
      out.push({ type: "text", text: record["text"] });
    } else if (
      record["type"] === "image" &&
      typeof record["data"] === "string" && record["data"] !== "" &&
      typeof record["mediaType"] === "string" && record["mediaType"] !== ""
    ) {
      out.push({ type: "image", data: record["data"], mimeType: record["mediaType"] });
    }
  }
  return out;
}

/** assistant 块整形：text → TextContent；tool_use → ToolCall（input 解析降 {}）；
 *  签名块重建 ThinkingContent（CONTEXT-TOKEN-UNIFICATION §3.1 L5——仅 openai 协议
 *  且 provenance 匹配当前路由；anthropic 按 B-1 裁决跳过待真端点实证）。 */
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

/** 签名载荷（SurfaceMessage.thinkingBlocks → pi ThinkingContent）重建门：
 *  ① 协议门——仅 openai-completions（B-1：anthropic 待真端点实证空文本+签名形态）；
 *  ② provenance 门——origin 与当前路由不匹配（跨模型切换/resume）不重建（维持
 *    pi 的跨模型降级语义，防路由 meta 伪造使其失效）；缺省 fail-closed 不重建；
 *  ③ 块序——thinking 块 prepend（协议要求居 content 首位）。 */
function signatureBlocksToContent(
  blocks: readonly { signature: string; redacted: boolean; origin: { provider: string; model: string } }[] | undefined,
  meta: { readonly api: string; readonly provider: string; readonly model: string },
): ThinkingContent[] {
  if (blocks === undefined || blocks.length === 0) return [];
  if (meta.api !== "openai-completions") return [];
  return blocks
    .filter((block) => block.origin.provider === meta.provider && block.origin.model === meta.model)
    .map((block) => ({ type: "thinking" as const, thinking: "", thinkingSignature: block.signature, ...(block.redacted ? { redacted: true } : {}) }));
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
        const content = userContent(message.content);
        if (content.length === 0) continue; // 空 user 整条跳过（垃圾降级，不换 400）
        out.push({
          role: "user",
          content,
          timestamp: 0,
        });
        break;
      }
      case "assistant": {
        const thinking = signatureBlocksToContent(message.thinkingBlocks, meta);
        const content = [...thinking, ...assistantContent(message.content, meta.api, meta.model)];
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
