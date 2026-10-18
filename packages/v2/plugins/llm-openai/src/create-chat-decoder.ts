import type { ProviderEvent, ProviderEnd, LlmResult, FinishReason } from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
import { readFrame, record, array, string, integer, readProviderError } from "../../llm-http/src/index";
import type { ProtocolInput, ProtocolDecoder, DecodedFrame } from "../../llm-http/src/index";
import { readChatUsage } from "./read-chat-usage";
import { readOpenaiCitation } from "./read-citation";
export function createChatDecoder(input: ProtocolInput): ProtocolDecoder {
  const blocks = new Map<string, { readonly id: string; readonly kind: "text" | "refusal" | "reasoning" | "tool-call" }>(); let next = 0; let end: ProviderEnd | undefined; let stopped = false; let responseId: string | undefined; let refused = false;
  const open = (key: string, kind: "text" | "refusal" | "reasoning" | "tool-call", events: ProviderEvent[]) => {
    let block = blocks.get(key); if (!block) { block = { id: `chat-${next++}`, kind }; blocks.set(key, block); events.push({ type: "block-start", block: kind === "reasoning" ? { id: block.id, kind, visibility: "text" } : { id: block.id, kind } }); } return block.id;
  };
  return {
    accept(frame): LlmResult<DecodedFrame> {
      if (stopped) return llmFailure("protocol-error", { phase: "stream" }); if (frame.data.trim() === "[DONE]") { if (!end) return llmFailure("protocol-error", { phase: "stream" }); stopped = true; return { ok: true, value: { events: [], stop: true } }; }
      const parsed = readFrame(frame); if (!parsed.ok) return parsed; const data = parsed.value; if (data.error !== undefined) return readProviderError(data.error); const events: ProviderEvent[] = [];
      if (data.id !== undefined) { if (!string(data.id) || (responseId !== undefined && data.id !== responseId)) return llmFailure("protocol-error", { phase: "stream" }); if (!responseId) { responseId = data.id as string; events.push({ type: "response-info", info: { protocol: input.model.protocol, responseId, ...(string(data.model) ? { model: data.model as string } : {}), ...(integer(data.created) !== undefined ? { createdAt: (data.created as number) * 1000 } : {}) } }); } }
      const choices = array(data.choices); if (!choices || choices.length > 1) return llmFailure(choices ? "unsupported-feature" : "protocol-error", { phase: "stream" });
      for (const raw of choices) {
        const choice = record(raw); const delta = record(choice?.delta); if (!choice || !delta || (choice.index !== undefined && choice.index !== 0) || (delta.role !== undefined && delta.role !== "assistant")) return llmFailure("protocol-error", { phase: "stream" });
        if (Object.keys(delta).some((key) => !["role", "content", "refusal", "tool_calls", "reasoning_content", "reasoning", "annotations"].includes(key))) return llmFailure("unsupported-feature", { phase: "stream" });
        if (end && (Object.keys(delta).length || choice.finish_reason !== null && choice.finish_reason !== undefined)) return llmFailure("protocol-error", { phase: "stream" });
        for (const [field, type, kind] of [["content", "text-delta", "text"], ["refusal", "refusal-delta", "refusal"], ["reasoning_content", "reasoning-delta", "reasoning"], ["reasoning", "reasoning-delta", "reasoning"]] as const) if (delta[field] !== undefined && delta[field] !== null) { if (typeof delta[field] !== "string" || (kind === "reasoning" && !input.model.reasoning)) return llmFailure("unsupported-feature", { phase: "stream" }); if (kind === "refusal" && delta[field]) refused = true; if (delta[field]) events.push({ type, id: open(kind, kind, events), delta: delta[field] as string }); }
        if (delta.tool_calls !== undefined) {
          const tools = array(delta.tool_calls); if (!tools || tools.length > input.limits.maxBlocks) return llmFailure("protocol-error", { phase: "stream" });
          for (const rawTool of tools) { const tool = record(rawTool); const index = integer(tool?.index); if (!tool || index === undefined || index >= input.limits.maxBlocks || (tool.type !== undefined && tool.type !== "function")) return llmFailure("protocol-error", { phase: "stream" }); const fn = tool.function === undefined ? {} : record(tool.function); if (!fn) return llmFailure("protocol-error", { phase: "stream" }); const id = open(`tool-${index}`, "tool-call", events);
            for (const [field, value] of [["callId", tool.id], ["name", fn.name], ["input", fn.arguments]] as const) if (value !== undefined) { if (typeof value !== "string") return llmFailure("protocol-error", { phase: "stream" }); events.push({ type: "tool-call-delta", id, field, delta: value }); }
          }
        }
        if (delta.annotations !== undefined) { const annotations = array(delta.annotations); if (!annotations) return llmFailure("protocol-error", { phase: "stream" }); const id = open("text", "text", events); for (const annotation of annotations) { const citation = readOpenaiCitation(annotation, { provider: input.provider, protocol: input.model.protocol }); if (!citation.ok) return citation; events.push({ type: "citation", id, citation: citation.value }); } }
        if (choice.logprobs !== undefined && choice.logprobs !== null) events.push({ type: "provider-event", scope: "request", name: "openai/chat/logprobs", data: choice.logprobs });
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) { const reason = string(choice.finish_reason); if (!reason || end) return llmFailure("protocol-error", { phase: "stream" }); end = { reason: reason === "stop" && refused ? { kind: "refusal" } : finishReason(reason), rawReason: reason }; for (const block of blocks.values()) events.push({ type: "block-end", id: block.id, status: ["length", "content-filter"].includes(end.reason.kind) ? "incomplete" : "complete" }); }
      }
      if (data.usage !== undefined && data.usage !== null) { const usage = readChatUsage(data.usage, end !== undefined); if (!usage.ok) return usage; events.push({ type: "usage", usage: usage.value }); }
      for (const name of ["system_fingerprint", "service_tier"]) if (data[name] !== undefined && data[name] !== null) events.push({ type: "provider-event", scope: "request", name: `openai/chat/${name}`, data: data[name]! });
      return { ok: true, value: { events, stop: false } };
    },
    finish() { return end ? { ok: true, value: end } : llmFailure("protocol-error", { phase: "stream" }); },
  };
}
function finishReason(raw: string): FinishReason { if (raw === "stop") return { kind: "stop" }; if (raw === "tool_calls") return { kind: "tool-calls" }; if (raw === "length") return { kind: "length", limit: "output" }; if (raw === "content_filter") return { kind: "content-filter" }; return { kind: "other", raw }; }
