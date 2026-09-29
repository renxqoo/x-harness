import type { Context, Message as PiMessage, Tool as PiTool, ToolCall } from "@earendil-works/pi-ai";
import type { ImageContent, TextContent, ThinkingContent } from "@earendil-works/pi-ai";
import type { SurfaceMessage } from "@x-harness/session";
import type { ToolSchema } from "@x-harness/tools";
import type { LlmRequest } from "./types.ts";

function parseToolInput(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
  }
  return {};
}

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

export function ensureToolPairing(messages: PiMessage[]): PiMessage[] {
  const toolUseIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall") toolUseIds.add(block.id);
    }
  }
  const filtered = messages.filter((message) => message.role !== "toolResult" || toolUseIds.has(message.toolCallId));
  const resultIds = new Set(filtered.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
  const stripped = filtered.map((message) => {
    if (message.role !== "assistant") return message;
    const content = message.content.filter((block) => block.type !== "toolCall" || resultIds.has(block.id));
    return content.length === message.content.length ? message : { ...message, content };
  });
  const final = stripped.filter((message) => message.role !== "assistant" || message.content.length > 0);
  return final.length === messages.length ? messages : final;
}

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

export function toPiMessages(
  messages: readonly SurfaceMessage[],
  meta: { readonly api: string; readonly provider: string; readonly model: string },
): PiMessage[] {
  const out: PiMessage[] = [];
  const nameByCallId = new Map<string, string>();
  for (const message of messages) {
    switch (message.role) {
      case "system":
        break;
      case "user": {
        const content = userContent(message.content);
        if (content.length === 0) continue;
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
    description: tool.description ?? "",
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
    messages: ensureToolPairing(toPiMessages(request.messages, meta)),
    ...(request.tools.length > 0 ? { tools: toPiTools(request.tools) } : {}),
  };
}
