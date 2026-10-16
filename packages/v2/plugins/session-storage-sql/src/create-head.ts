import type { Query } from "./types";
import type { NamespaceOptions } from "./types";
import type { SessionResult } from "../../session/src/contracts";
import { fail } from "./fail";

export async function createHead(query: Query, input: { id: string; origin: string; metadata: string; parent?: { id: string; revision: number } }, options: NamespaceOptions): Promise<SessionResult<void>> {
  const counted = await query.all("UPDATE xh_session_namespaces SET sessions=sessions+1 WHERE namespace=$1 AND sessions<$2 RETURNING sessions", [options.namespace, options.limits.maxSessions]);
  if (!counted.length) return fail("capacity-exceeded");
  await query.all("INSERT INTO xh_session_heads(namespace,id,origin,created,revision,bytes,metadata,parent,parent_revision) VALUES ($1,$2,$3,$4,0,0,$5,$6,$7)", [options.namespace, input.id, input.origin, Date.now(), input.metadata, input.parent?.id ?? null, input.parent?.revision ?? null]);
  return { ok: true, value: undefined };
}
