import { defineGuard, defineEvent } from "../../../../core/src/index";
import { createFault } from "../../../../core/src/validation";
import { readAuthorization } from "../planning/create-authorization";
import type { ToolAuthorization } from "../planning/types";
const guard = defineGuard<ToolAuthorization>({
  name: "tools/execution-access",
  input: readAuthorization,
});

if (!guard.ok) throw new Error("Invalid execution access definition");

export const toolExecutionAccess = guard.value;
const event = defineEvent<null>({
  name: "tools/availability",
  payload: (raw) => (raw === null ? { ok: true, value: null } : createFault("invalid-input")),
});

if (!event.ok) throw new Error("Invalid availability definition");

export const toolAvailability = event.value;
