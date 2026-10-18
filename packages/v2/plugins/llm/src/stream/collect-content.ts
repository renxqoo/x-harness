import type { LlmOutputBlock } from "../contracts";
import type { StreamState } from "./types";
export function collectContent(state: StreamState): readonly LlmOutputBlock[] {
  return Object.freeze([...state.blocks.values()].map((value) => Object.freeze({ block: value.block, status: value.status, ...(["text", "refusal", "reasoning"].includes(value.block.kind) ? { text: value.chunks.join("") } : {}), ...(value.signatures.length ? { signature: value.signatures.join("") } : {}), ...(value.call ? { call: value.call } : {}), ...(value.continuation ? { continuation: value.continuation } : {}), citations: Object.freeze(value.citations), providerEvents: Object.freeze(value.providerEvents) })));
}
