import type { LlmRequest, LlmLimits } from "../contracts";
import type { StreamState } from "./types";
export function createStreamState(input: { readonly request: LlmRequest; readonly provider: string; readonly protocol: string; readonly canonicalModel?: string; readonly limits: LlmLimits; readonly collect: boolean }): StreamState {
  const sourceIds = new Set<string>(); for (const message of input.request.messages) for (const block of message.content) if (block.type === "document" || block.type === "search-result") sourceIds.add(block.sourceId);
  return { ...input, canonicalModel: input.canonicalModel ?? input.request.model, keepText: input.collect || (input.request.output !== undefined && input.request.output.type !== "text"), blocks: new Map(), callIds: new Set(), sourceIds, usage: Object.freeze({ complete: false }), response: Object.freeze({ protocol: input.protocol }), hasOutput: false, sealed: false };
}
