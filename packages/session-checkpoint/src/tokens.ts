import { defineEvent } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";

export const checkpointDiagnostic = defineEvent<{
  readonly session: SessionId;
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}>("session-checkpoint/diagnostic", { freeze: "none" });
