import type { Query } from "./types";
import type { NamespaceOptions } from "./types";
import type { SessionResult } from "../../session/src/contracts";
import { fail } from "./fail";

export async function initializeStore(query: Query, options: NamespaceOptions): Promise<SessionResult<void>> {
  await query.lock("xh-session/schema");
  for (const statement of [
    "CREATE TABLE IF NOT EXISTS xh_session_format (signature TEXT PRIMARY KEY)",
    "CREATE TABLE IF NOT EXISTS xh_session_namespaces (namespace TEXT PRIMARY KEY, settings TEXT NOT NULL, sessions BIGINT NOT NULL CHECK(sessions>=0))",
    "CREATE TABLE IF NOT EXISTS xh_session_heads (namespace TEXT NOT NULL, id TEXT NOT NULL, origin TEXT NOT NULL, created BIGINT NOT NULL, revision BIGINT NOT NULL CHECK(revision>=0), bytes BIGINT NOT NULL CHECK(bytes>=0), metadata TEXT NOT NULL, parent TEXT, parent_revision BIGINT, PRIMARY KEY(namespace,id), FOREIGN KEY(namespace) REFERENCES xh_session_namespaces(namespace))",
    "CREATE TABLE IF NOT EXISTS xh_session_records (namespace TEXT NOT NULL, id TEXT NOT NULL, seq BIGINT NOT NULL CHECK(seq>0), time BIGINT NOT NULL, entry TEXT NOT NULL, bytes BIGINT NOT NULL CHECK(bytes>0), PRIMARY KEY(namespace,id,seq), FOREIGN KEY(namespace,id) REFERENCES xh_session_heads(namespace,id))",
    "CREATE TABLE IF NOT EXISTS xh_session_commits (namespace TEXT NOT NULL, id TEXT NOT NULL, commit_id TEXT NOT NULL, fingerprint TEXT NOT NULL, first_seq BIGINT NOT NULL, last_seq BIGINT NOT NULL, PRIMARY KEY(namespace,id,commit_id), FOREIGN KEY(namespace,id) REFERENCES xh_session_heads(namespace,id))",
    "CREATE TABLE IF NOT EXISTS xh_session_view (namespace TEXT NOT NULL, id TEXT NOT NULL, position BIGINT NOT NULL CHECK(position>0), seq BIGINT NOT NULL, PRIMARY KEY(namespace,id,position), UNIQUE(namespace,id,seq), FOREIGN KEY(namespace,id,seq) REFERENCES xh_session_records(namespace,id,seq))",
  ]) await query.all(statement);
  const signature = "immutable-history-position-view-commit-receipt";
  const formats = await query.all("SELECT signature FROM xh_session_format");
  if (formats.length && (formats.length !== 1 || formats[0]?.signature !== signature)) return fail("configuration-conflict");
  await query.all("INSERT INTO xh_session_format(signature) VALUES ($1) ON CONFLICT DO NOTHING", [signature]);
  const limits = options.limits;
  const settings = JSON.stringify([limits.maxRecordBytes, limits.maxSessionBytes, limits.maxRecords, limits.maxConversationNodes, limits.maxMetadataBytes, limits.maxSessions]);
  await query.all("INSERT INTO xh_session_namespaces(namespace, settings, sessions) VALUES ($1,$2,0) ON CONFLICT DO NOTHING", [options.namespace, settings]);
  const rows = await query.all("SELECT settings FROM xh_session_namespaces WHERE namespace=$1", [options.namespace]);
  if (rows[0]?.settings !== settings) return fail("configuration-conflict");
  return { ok: true, value: undefined };
}
