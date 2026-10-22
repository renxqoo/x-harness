import { createFault } from "../../../../core/src/validation";
import type { ScheduleAccess } from "../contracts/types";
import { data, keys } from "./read-values";
import { readCalls } from "./read-calls";
import { maximumSchedulerLimits } from "./read-limits";
const known = new WeakSet<object>();

export function readAccess(raw: unknown) {
  if (raw && typeof raw === "object" && known.has(raw))
    return { ok: true as const, value: raw as ScheduleAccess };

  const d = data(raw),
    origin = d ? data(d.origin) : undefined;

  if (
    !d ||
    !keys(d, ["operation", "origin", "calls"]) ||
    !["execute", "batch"].includes(d.operation as string) ||
    !origin ||
    !keys(origin, ["scopeId", "pluginName"]) ||
    typeof origin.scopeId !== "string" ||
    origin.scopeId.length > 160 ||
    (origin.pluginName !== undefined &&
      (typeof origin.pluginName !== "string" || origin.pluginName.length > 160))
  )
    return createFault("invalid-input");

  const calls = readCalls(d.calls, maximumSchedulerLimits);

  if (!calls.ok) return createFault("invalid-input");

  const value = Object.freeze({
    operation: d.operation,
    origin: Object.freeze(origin),
    calls: calls.value,
  }) as unknown as ScheduleAccess;
  known.add(value);
  return { ok: true as const, value };
}
