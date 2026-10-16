import { readData } from "../../../core/src/validation";
import type { SessionResult } from "../../session/src/contracts";
import type { JsonlLimits } from "./types";
import { fail } from "./fail";
export interface JsonlSessionOptions { readonly path?: string; readonly limits?: Partial<JsonlLimits> }
export const defaultJsonlLimits: JsonlLimits = Object.freeze({ maxQueue: 64, lockTimeoutMs: 1000, operationTimeoutMs: 10000 });
export function readOptions(raw: unknown): SessionResult<{ path: string; limits: JsonlLimits }> {
  const read = readData(raw); if (!read.ok || Object.keys(read.value).some((key) => !["path", "limits"].includes(key))) return fail("invalid-input");
  const path = read.value.path ?? "./data/sessions-jsonl"; if (typeof path !== "string" || !path || path.includes("\0") || path.length > 4096) return fail("invalid-input");
  const values = readData(read.value.limits ?? {}); if (!values.ok || Object.keys(values.value).some((key) => !Object.hasOwn(defaultJsonlLimits, key))) return fail("invalid-input");
  const limits = { ...defaultJsonlLimits, ...values.value } as JsonlLimits;
  for (const key of Object.keys(defaultJsonlLimits) as (keyof JsonlLimits)[]) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > defaultJsonlLimits[key] * 4) return fail("invalid-input");
  return { ok: true, value: { path, limits: Object.freeze(limits) } };
}
