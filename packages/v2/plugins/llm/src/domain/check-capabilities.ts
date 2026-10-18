import type { LlmRequest, LlmResult, ModelDescription } from "../contracts";
import { fail } from "./fail";
export function checkCapabilities(request: LlmRequest, model: ModelDescription, provider: string): LlmResult<void> {
  if (!model.output.includes(request.output?.type ?? "text") || (request.tools?.length && !model.tools) || request.providerTools?.some((tool) => !model.providerTools.includes(tool.type)) || (request.maxOutputTokens !== undefined && model.maxOutputTokens !== undefined && request.maxOutputTokens > model.maxOutputTokens)) return fail("unsupported-feature");
  const reasoning = request.reasoning; if (reasoning && (!model.reasoning || (reasoning.effort !== undefined && !model.reasoning.efforts.includes(reasoning.effort)) || (reasoning.budgetTokens !== undefined && !model.reasoning.budget) || (reasoning.display !== undefined && !model.reasoning.display.includes(reasoning.display)))) return fail("unsupported-feature");
  for (const message of request.messages) {
    if (message.role === "developer" && !model.developer) return fail("unsupported-feature");
    for (const block of message.content) {
      if (["text", "image", "document", "search-result"].includes(block.type) && !model.input.includes(block.type as "text" | "image" | "document" | "search-result")) return fail("unsupported-feature");
      if (block.type === "tool-call" && !model.tools) return fail("unsupported-feature");
      if ((block.type === "document" || block.type === "search-result") && block.citations && (!model.citations || (model.protocol === "anthropic-messages" && request.output?.type === "json-schema"))) return fail("unsupported-feature");
      if (block.type === "reasoning" || block.type === "provider") { const continuation = block.continuation; if (continuation && (continuation.provider !== provider || continuation.protocol !== model.protocol || continuation.model !== (model.canonicalModel ?? model.model))) return fail("invalid-input"); }
    }
  }
  return { ok: true, value: undefined };
}
