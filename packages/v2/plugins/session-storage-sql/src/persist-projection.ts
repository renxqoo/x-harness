import type { Query } from "./types";
import type { StorageNode } from "../../session/src/storage";

export async function persistProjection(
  query: Query,
  input: {
    namespace: string;
    id: string;
    before: readonly StorageNode[];
    after: readonly StorageNode[];
  },
): Promise<void> {
  const old = new Map(input.before.map((node) => [node.seq, node.position]));
  const current = new Map(input.after.map((node) => [node.seq, node.position]));
  const removed = input.before.filter((node) => current.get(node.seq) !== node.position);
  const added = input.after.filter((node) => old.get(node.seq) !== node.position);

  for (let offset = 0; offset < removed.length; offset += 128) {
    const batch = removed.slice(offset, offset + 128);
    await query.all(
      `DELETE FROM xh_session_view WHERE namespace=$1 AND id=$2 AND seq IN (${batch.map((_, i) => `$${i + 3}`).join(",")})`,
      [input.namespace, input.id, ...batch.map((node) => node.seq)],
    );
  }

  for (let offset = 0; offset < added.length; offset += 128) {
    const batch = added.slice(offset, offset + 128);
    const values: (string | number)[] = [];
    const rows: string[] = [];

    for (const node of batch) {
      const start = values.length;
      values.push(input.namespace, input.id, node.position, node.seq);
      rows.push(`($${start + 1},$${start + 2},$${start + 3},$${start + 4})`);
    }

    await query.all(
      `INSERT INTO xh_session_view(namespace,id,position,seq) VALUES ${rows.join(",")}`,
      values,
    );
  }
}
