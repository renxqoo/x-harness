import type { Query, NamespaceOptions } from "./types";
import type { StorageList, StorageListPage } from "../../session/src/storage";
import { createStorageListPage } from "../../session/src/storage";
import type { SessionResult } from "../../session/src/contracts";
import { integer } from "./read-head";
import { textOrder } from "./text-order";

export async function listSessions(
  query: Query,
  options: NamespaceOptions,
  input: StorageList,
): Promise<SessionResult<StorageListPage>> {
  const page = createStorageListPage(input, options.limits);
  const order = textOrder(query);
  let after = input.after ?? "";
  let read = 0;

  for (;;) {
    const maximum = Math.min(32, input.limit + 1 - read);
    const rows = await query.all(
      `SELECT id,created,metadata,parent,parent_revision FROM xh_session_heads WHERE namespace=$1 AND id COLLATE ${order}>$2 ORDER BY id COLLATE ${order} LIMIT $3`,
      [input.namespace, after, maximum],
    );

    for (const row of rows) {
      const result = page.add({
        id: row.id,
        createdAt: integer(row, "created"),
        metadata: row.metadata,
        ...(row.parent !== null
          ? { parent: { id: row.parent, revision: integer(row, "parent_revision") } }
          : {}),
      });

      if (!result.ok) return result;

      if (!result.value) return { ok: true, value: page.finish() };

      after = row.id as string;
      read++;
    }

    if (rows.length < maximum) return { ok: true, value: page.finish() };
  }
}
