import { defineEvent, defineService } from "@x-harness/core";
import type { AskPayload, AskReply, PermissionAudit, RuleEntry } from "./types.ts";

export const permissionBroker = defineService<{ ask(input: AskPayload): Promise<AskReply> }>("permission/broker");

export const permissionGrantStore = defineService<{
  write(scope: "project" | "user", entry: RuleEntry): Promise<{ ok: true } | { ok: false; reason: string }>;
}>("permission/grant-store");

export const permissionGrants = defineService<import("./grants.ts").GrantsRegistry>("permission/grants");

export interface PermissionModeService {
  get(): string;
  set(mode: string): void;
}
export const permissionMode = defineService<PermissionModeService>("permission/mode");

export const permissionAdjudicate = defineService<(payload: { readonly name: string; readonly args: unknown; readonly session?: import("@x-harness/session").SessionId; readonly control?: true; readonly kind?: string }) => import("./decide.ts").Decision>("permission/adjudicate");

export const permissionDecided = defineEvent<PermissionAudit>("permission/decided", { freeze: "deep" });

export const permissionGrantWritten = defineEvent<{ readonly scope: "session" | "project" | "user"; readonly rule: string; readonly from: string }>("permission/grant-written", {
  freeze: "deep",
});

export interface FenceFactsResolver {
  forSession(session: import("@x-harness/session").SessionId | undefined): import("./types.ts").FenceFacts;
}
export const fenceFacts = defineService<FenceFactsResolver>("permission/fence-facts");
