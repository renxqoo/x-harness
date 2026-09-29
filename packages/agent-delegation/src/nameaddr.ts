import type { SessionId } from "@x-harness/session";
import type { ChildRow, Lineage } from "./lineage.ts";

export type Resolution =
  | { readonly kind: "row"; readonly row: ChildRow }
  | { readonly kind: "main"; readonly parent: SessionId }
  | { readonly kind: "miss"; readonly reason: string };

const AGENT_ID = /^agent-[0-9a-f]+$/;

export function resolveAddress(lineage: Lineage, caller: SessionId, to: string): Resolution {
  if (to === "main") {
    const callerRow = lineage.bySession(caller);
    if (callerRow === undefined) return { kind: "miss", reason: "invalid-args:to 'main' is only available to background sub-agents" };
    return { kind: "main", parent: callerRow.parent };
  }
  if (AGENT_ID.test(to)) {
    const row = lineage.get(to);
    return row === undefined ? { kind: "miss", reason: `not-found:${to}` } : { kind: "row", row };
  }
  return { kind: "miss", reason: `not-found:${to}; agent ids look like 'agent-<hex>' (from agent_spawn), or 'main', or a local session name` };
}
