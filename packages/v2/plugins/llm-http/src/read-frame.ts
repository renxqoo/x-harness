import type { JsonObject, LlmResult } from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
import type { SseFrame } from "./types";
export function readFrame(frame: SseFrame): LlmResult<JsonObject> {
  try { const value: unknown = JSON.parse(frame.data); return value !== null && typeof value === "object" && !Array.isArray(value) ? { ok: true, value: value as JsonObject } : llmFailure("protocol-error", { phase: "stream" }); } catch { return llmFailure("protocol-error", { phase: "stream" }); }
}
export function record(value: unknown): JsonObject | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined; }
export function array(value: unknown): readonly import("../../../core/src/index").JsonValue[] | undefined { return Array.isArray(value) ? value as readonly import("../../../core/src/index").JsonValue[] : undefined; }
export function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
export function integer(value: unknown): number | undefined { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined; }
