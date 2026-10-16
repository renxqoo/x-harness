import type { Parameters, Query } from "./types";

import type { StoredRecord } from "../../session/src/storage";
export async function insertRecords(query: Query, input: { namespace: string; id: string; records: readonly StoredRecord[] }): Promise<void> {
  if (!input.records.length) return;
  const values: (string | number)[] = []; const rows: string[] = [];
  for (const record of input.records) {
    const start = values.length; values.push(input.namespace, input.id, record.seq, record.time, record.json, record.bytes);
    rows.push(`(${Array.from({ length: 6 }, (_, i) => `$${start + i + 1}`).join(",")})`);
  }
  await query.all(`INSERT INTO xh_session_records(namespace,id,seq,time,entry,bytes) VALUES ${rows.join(",")}`, values as Parameters);
}
