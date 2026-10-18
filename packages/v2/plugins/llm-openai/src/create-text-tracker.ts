import type { LlmResult } from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
export function createTextTracker(limit: number, budget: { bytes: number; readonly max: number }) {
  const chunks: string[] = []; let bytes = 0; let length = 0; let final: string | undefined; const encoder = new TextEncoder();
  return {
    append(value: string): LlmResult<void> { if (final !== undefined) return llmFailure("protocol-error"); const size = encoder.encode(value).length; if (bytes + size > limit || budget.bytes + size > budget.max) return llmFailure("capacity-exceeded"); chunks.push(value); bytes += size; budget.bytes += size; length += value.length; return { ok: true, value: undefined }; },
    complete(value: unknown): LlmResult<string> { if (typeof value !== "string") return llmFailure("protocol-error"); if (final !== undefined) return value === final ? { ok: true, value: "" } : llmFailure("protocol-error"); let offset = 0; for (const chunk of chunks) { if (!value.startsWith(chunk, offset)) return llmFailure("protocol-error"); offset += chunk.length; } const size = encoder.encode(value).length; if (size > limit || budget.bytes - bytes + size > budget.max) return llmFailure("capacity-exceeded"); const suffix = value.slice(length); budget.bytes += size - bytes; bytes = size; chunks.length = 0; final = value; return { ok: true, value: suffix }; },
    value: () => final,
    close() { chunks.length = 0; final = undefined; budget.bytes -= bytes; bytes = 0; length = 0; },
  };
}
