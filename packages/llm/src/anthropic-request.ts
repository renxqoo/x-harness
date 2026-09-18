// Anthropic 请求转换（docs/LLM.md §1.5）：SurfaceMessage → Messages API 请求体。
// system 顶层化；相邻同角色合并（tool_result 块前置、user 文本独立块）；孤立 tool_use 合成空结果
// （中断/中止的历史重放不再 400 砖化）；tool_use input 解析失败或非对象降 {}；空 user 跳过。

import type { LlmRequest } from "./types.ts";
import type { SurfaceMessage } from "@x-harness/session";
import type { ToolSchema } from "@x-harness/tools";

type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
  | { readonly type: "tool_result"; readonly tool_use_id: string; readonly content: string; readonly is_error?: true };

export interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: readonly ContentBlock[];
}

export interface AnthropicRequestBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly stream: true;
  readonly messages: readonly AnthropicMessage[];
  readonly system?: string;
  readonly tools?: Array<{ readonly name: string; readonly description?: string; readonly input_schema: unknown }>;
  readonly temperature?: number;
}

/** 协议硬约束：max_tokens 必填；Agent 写大文件负载下 4096 易截断误判收轮 */
export const DEFAULT_MAX_TOKENS = 8192;

/** tool_use input：parse 失败或非 plain object（null/数组/原始值）→ {}——Anthropic 要对象，垃圾不崩 */
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

/** assistant 内容块 → Anthropic 块（text 原样；tool_use input 解析降 {}；callId 待答计数 +1） */
function assistantBlocks(content: unknown, openToolUses: Map<string, number>): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    const record = blockRecord(block);
    if (record === undefined) continue;
    if (record["type"] === "text" && typeof record["text"] === "string" && record["text"] !== "") {
      blocks.push({ type: "text", text: record["text"] });
    }
    const callId = str(record["callId"]);
    const name = str(record["name"]);
    const input = str(record["input"]);
    if (record["type"] === "tool_use" && callId !== undefined && name !== undefined && input !== undefined) {
      blocks.push({ type: "tool_use", id: callId, name, input: parseToolInput(input) });
      openToolUses.set(callId, (openToolUses.get(callId) ?? 0) + 1); // 出现次数配对（重复 callId 各计一次）
    }
  }
  return blocks;
}

function blockRecord(block: unknown): Record<string, unknown> | undefined {
  return typeof block === "object" && block !== null ? (block as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 孤立 tool_use（无 tool/result 配对——interrupted/中止的历史）合成空结果，附到其后的首个 user 组 */
function syntheticResults(openToolUses: Map<string, number>): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const [id, remaining] of openToolUses) {
    for (let i = 0; i < remaining; i++) {
      blocks.push({ type: "tool_result", tool_use_id: id, content: "(no result provided)", is_error: true });
    }
  }
  openToolUses.clear();
  return blocks;
}

function toAnthropicMessages(messages: readonly SurfaceMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  const openToolUses = new Map<string, number>(); // callId → 未答次数（出现次数配对——重复 callId 各计一次）
  let pendingBlocks: ContentBlock[] = []; // 相邻 user/tool 组的累积块（tool_result 前、text 后）

  const flushUserGroup = (): void => {
    const synthetics = syntheticResults(openToolUses);
    const blocks = [...synthetics, ...pendingBlocks];
    pendingBlocks = [];
    if (blocks.length === 0) return;
    out.push({ role: "user", content: blocks });
  };

  for (const message of messages) {
    switch (message.role) {
      case "system":
        break; // 顶层化，调用方收集
      case "user": {
        const texts = textBlocksOf(message.content);
        if (texts.length === 0) continue; // 空 user 整条跳过（垃圾降级，不发空串换 400）
        for (const text of texts) pendingBlocks.push({ type: "text", text });
        break;
      }
      case "assistant": {
        flushUserGroup();
        const blocks = assistantBlocks(message.content, openToolUses);
        if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
        break;
      }
      case "tool": {
        const remaining = openToolUses.get(message.callId) ?? 0;
        if (remaining === 0) break; // 无主 tool_result（乱序/垃圾卷）：丢弃——无 tool_use 配对会 400
        openToolUses.set(message.callId, remaining - 1);
        const block: ContentBlock = {
          type: "tool_result",
          tool_use_id: message.callId,
          content: message.content ?? "",
          ...(message.isError === true ? { is_error: true } : {}),
        };
        // tool_result 块必须位于组内最前：重组为 [既有 tool_result..., 新 tool_result, ...既有 text]
        const results = pendingBlocks.filter((b) => b.type === "tool_result");
        const texts = pendingBlocks.filter((b) => b.type !== "tool_result");
        pendingBlocks = [...results, block, ...texts];
        break;
      }
    }
  }
  flushUserGroup();
  const tail = syntheticResults(openToolUses);
  if (tail.length > 0) out.push({ role: "user", content: tail }); // 尾部孤立：独立收尾组
  return out;
}

function toAnthropicTools(tools: readonly ToolSchema[]): Array<{ name: string; description?: string; input_schema: unknown }> {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    input_schema: tool.inputSchema,
  }));
}

export function toAnthropicRequest(request: LlmRequest, maxTokensDefault: number | undefined): AnthropicRequestBody {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => (message as { text?: string }).text ?? "")
    .filter((text) => text !== "")
    .join("\n\n");
  return {
    model: request.model,
    max_tokens: request.maxTokens ?? maxTokensDefault ?? DEFAULT_MAX_TOKENS,
    stream: true,
    messages: toAnthropicMessages(request.messages),
    ...(system !== "" ? { system } : {}),
    ...(request.tools.length > 0 ? { tools: toAnthropicTools(request.tools) } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  };
}
