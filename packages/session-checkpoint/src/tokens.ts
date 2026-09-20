// session-checkpoint 件 token：观测事件（freeze none）。

import { defineEvent } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";

/** 诊断事件：结构化诊断码——事件总线消费者可见（不只 stderr） */
export const checkpointDiagnostic = defineEvent<{
  readonly session: SessionId;
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}>("session-checkpoint/diagnostic", { freeze: "none" });
