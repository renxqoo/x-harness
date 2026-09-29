import { defineEvent, defineGuard, defineParallel, defineService } from "@x-harness/core";
import type { SessionArchive, SessionEvent, SessionHeader, SessionId, SessionStore } from "./types.ts";

export const sessionStore = defineService<SessionStore>("session-store");

export const sessionArchive = defineService<SessionArchive>("session-archive");

export const sessionAuditDrain = defineService<{ drain(): void }>("session-audit-drain");

export const sessionCreateGuard = defineGuard<{ readonly header: SessionHeader }>("session/create-guard");

export const sessionCreated = defineEvent<{ readonly header: SessionHeader }>("session/created", { freeze: "none" });

export const sessionEvent = defineEvent<{ readonly session: SessionId; readonly event: SessionEvent }>("session/event", {
  freeze: "none",
});

export const sessionAuditEvent = defineEvent<{ readonly session: SessionId; readonly event: SessionEvent }>(
  "session/audit-event",
  { freeze: "none" },
);

export const sessionFlush = defineParallel<{ readonly session: SessionId }>("session/flush");

export const sessionDisposed = defineEvent<{ readonly session: SessionId }>("session/disposed", { freeze: "none" });


export const THINKING_LEVELS = ["off", "low", "medium", "high", "max"] as const;
export type ThinkingLevelValue = (typeof THINKING_LEVELS)[number];

export const TODO_SNAPSHOT_STATUS_VALUES = ["pending", "in_progress", "completed"] as const;

export const INBOX_TARGET_VALUES = ["next-turn", "next-step"] as const;
