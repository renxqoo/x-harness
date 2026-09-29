import type { SessionId } from "@x-harness/session";

export type Verdict = "allow" | "deny" | "ask";
export type RuleTool = "Danger" | "Read" | "Write" | "Tool";
export type RuleOrigin = "user" | "project" | "session" | "default";
export type RuleNature = "handwritten" | "grant";

export interface PermissionRule {
  readonly tool: RuleTool;
  readonly pattern: string;
  readonly verdict: Verdict;
  readonly origin: RuleOrigin;
  readonly nature?: RuleNature;
  readonly outsideRoots?: true;
  readonly at?: number;
}

export interface RuleEntry {
  readonly tool: RuleTool;
  readonly pattern: string;
  readonly verdict: Verdict;
  readonly nature: RuleNature;
  readonly at?: number;
}

export type ExecDirective = "direct" | "contained";

export interface PermissionProfile {
  readonly id: string;
  readonly askPolicy: "never" | "on-failure" | "on-opaque" | "always";
  readonly containment: "none" | "fenced";
  readonly mutationPolicy: "plan-deny" | "confirm-all" | "auto-in-root";
}

export type ProfileId = "plan" | "auto" | "edit-confirm" | "full" | "sandboxed-auto";

export const PROFILE_IDS = ["plan", "auto", "edit-confirm", "full", "sandboxed-auto"] as const satisfies readonly ProfileId[];

export interface FenceFacts {
  readonly writable: readonly string[];
}


export interface AskPayload {
  readonly tool: string;
  readonly summary?: string;
  readonly reason: string;
  readonly options: readonly ("once" | "session" | "project" | "user")[];
  readonly suggestedRule?: string;
  readonly escalate?: { readonly command: string; readonly failureText: string };
  readonly session?: SessionId;
}

export interface AskReply {
  readonly verdict: "allow" | "deny";
  readonly memory?: "session" | "project" | "user";
  readonly ruleOverride?: string;
}

export interface PermissionAudit {
  readonly tool: string;
  readonly verdict: Verdict;
  readonly resolvedBy: string;
  readonly reason: string;
  readonly exec?: ExecDirective;
  readonly session?: SessionId;
}
