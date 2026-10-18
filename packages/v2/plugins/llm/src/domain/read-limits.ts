import { readData } from "../../../../core/src/validation";
import type { LlmLimits, LlmResult } from "../contracts";
import { fail } from "./fail";
const defaults: LlmLimits = Object.freeze({ maxActiveRequests: 32, maxProviders: 32, maxInputBytes: 16777216, maxMessages: 4096, maxTools: 256, maxBlocks: 512, maxEventBytes: 1048576, maxToolInputBytes: 262144, maxContinuationBytes: 524288, maxOutputBytes: 16777216, maxEvents: 200000, maxJsonDepth: 32, maxJsonNodes: 100000, timeoutMs: 180000, headersTimeoutMs: 30000, idleTimeoutMs: 60000, consumerTimeoutMs: 30000 });
export const maximumLlmLimits: LlmLimits = { maxActiveRequests: 256, maxProviders: 128, maxInputBytes: 67108864, maxMessages: 8192, maxTools: 1024, maxBlocks: 2048, maxEventBytes: 4194304, maxToolInputBytes: 1048576, maxContinuationBytes: 1048576, maxOutputBytes: 67108864, maxEvents: 1000000, maxJsonDepth: 64, maxJsonNodes: 200000, timeoutMs: 1800000, headersTimeoutMs: 120000, idleTimeoutMs: 600000, consumerTimeoutMs: 600000 };
export function readLlmLimits(raw: unknown = {}, provider = false): LlmResult<LlmLimits> {
  const read = readData(raw); if (!read.ok || Object.keys(read.value).some((key) => !(key in defaults))) return fail("invalid-input");
  const values = { ...defaults, ...(provider ? { maxActiveRequests: 16 } : {}) };
  for (const key of Object.keys(read.value) as (keyof LlmLimits)[]) { const value = read.value[key]; if (value === undefined) continue; if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximumLlmLimits[key]) return fail("invalid-input"); values[key] = value as number; }
  return { ok: true, value: Object.freeze(values) };
}
