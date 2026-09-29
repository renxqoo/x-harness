import type { Result } from "@x-harness/core";
import type { SessionHeader, SessionId } from "@x-harness/session";

export function mainSessions(headers: readonly SessionHeader[]): readonly SessionHeader[] {
  return headers
    .filter((header) => header.agentId === undefined)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);
}

export type PrefixMatch =
  | { readonly status: "unique"; readonly id: SessionId }
  | { readonly status: "none" }
  | { readonly status: "ambiguous"; readonly candidates: readonly SessionId[] };

export function matchPrefix(headers: readonly SessionHeader[], prefix: string): PrefixMatch {
  const hits = mainSessions(headers).filter((header) => header.id.startsWith(prefix));
  const first = hits[0];
  if (first === undefined) return { status: "none" };
  if (hits.length === 1) return { status: "unique", id: first.id };
  return { status: "ambiguous", candidates: hits.map((header) => header.id) };
}

export function continueCandidate(headers: readonly SessionHeader[], cwd: string): SessionId | undefined {
  return mainSessions(headers).find((header) => header.cwd === cwd)?.id;
}

export type SessionPlan =
  | { readonly kind: "new" }
  | { readonly kind: "resume"; readonly id: SessionId }
  | { readonly kind: "pick"; readonly headers: readonly SessionHeader[] }
  | { readonly kind: "fail"; readonly reason: string };

export function planSession(args: { readonly session?: string; readonly continueRecent: boolean; readonly resume: boolean }, headers: readonly SessionHeader[], cwd: string): SessionPlan {
  if (args.session !== undefined) {
    const match = matchPrefix(headers, args.session);
    if (match.status === "unique") return { kind: "resume", id: match.id };
    if (match.status === "none") return { kind: "fail", reason: `no session matches prefix "${args.session}"` };
    return { kind: "fail", reason: `prefix "${args.session}" is ambiguous: ${match.candidates.join(", ")}` };
  }
  if (args.continueRecent) {
    const id = continueCandidate(headers, cwd);
    return id === undefined ? { kind: "new" } : { kind: "resume", id };
  }
  if (args.resume) {
    const list = mainSessions(headers);
    return list.length === 0 ? { kind: "fail", reason: "no saved sessions" } : { kind: "pick", headers: list };
  }
  return { kind: "new" };
}

export function planToResult(plan: SessionPlan): Result<Exclude<SessionPlan, { kind: "fail" } | { kind: "pick" }>> {
  if (plan.kind === "fail") return { ok: false, reason: plan.reason };
  if (plan.kind === "pick") return { ok: false, reason: "pick requires an interactive terminal" };
  return { ok: true, value: plan };
}
