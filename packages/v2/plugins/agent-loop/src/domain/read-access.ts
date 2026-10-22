import type { AgentAccess } from "../contracts/types";
import { data, keys } from "./read-values";
import { fail } from "./fail";
import { readContext } from "./read-context";

export function readAccess(raw: unknown) {
  const d = data(raw);

  if (
    !d ||
    !keys(d, ["runId", "step", "caller", "metadata", "request", "phase"]) ||
    !["context", "model", "tools"].includes(d.phase as string)
  )
    return fail("invalid-input");

  const { phase, ...fields } = d;
  const base = readContext(fields);
  return base.ok
    ? {
        ok: true as const,
        value: Object.freeze({ ...base.value, phase: phase as AgentAccess["phase"] }),
      }
    : base;
}
