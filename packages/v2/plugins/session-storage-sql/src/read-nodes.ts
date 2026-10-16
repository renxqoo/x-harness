import type { Query } from "./types";
import type { StorageNode } from "../../session/src/storage";
import type { SessionResult } from "../../session/src/contracts";
import { integer } from "./read-head";
import { fail } from "./fail";

export async function readNodes(query: Query, input: { namespace: string; id: string; maximum: number; revision: number }): Promise<SessionResult<readonly StorageNode[]>> {
  const { namespace, id, maximum, revision } = input;
  const rows = await query.all("SELECT position,seq FROM xh_session_view WHERE namespace=$1 AND id=$2 ORDER BY position LIMIT $3", [namespace, id, maximum + 1]);
  if (rows.length > maximum) return fail("storage-corrupt");
  const nodes: StorageNode[] = []; const seen = new Set<number>(); let previous = 0;
  for (const row of rows) { const position = integer(row, "position"); const seq = integer(row, "seq"); if (!position || !seq || position <= previous || seq > revision || position > seq || seen.has(seq)) return fail("storage-corrupt"); nodes.push(Object.freeze({ position, seq })); previous = position; seen.add(seq); }
  return { ok: true, value: Object.freeze(nodes) };
}
