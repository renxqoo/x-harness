import { definePlugin } from "../../../core/src/index";
import type { Plugin } from "../../../core/src/index";
import { readData, createFault } from "../../../core/src/validation";
import { sessionStorage } from "../../session/src/storage";
import type { SessionResult } from "../../session/src/contracts";
import { openSqlStore, createSqlStorage, readStorageLimits } from "../../session-storage-sql/src/index";
import type { StorageLimits } from "../../session-storage-sql/src/index";
import { openSqlite } from "./open-sqlite";

export interface SqliteSessionOptions { readonly path?: string; readonly limits?: Partial<StorageLimits> }
export function createSqliteSessionPlugin(input: SqliteSessionOptions = {}): SessionResult<Plugin> {
  const read = readData(input); if (!read.ok || Object.keys(read.value).some((key) => !["path", "limits"].includes(key))) return { ok: false, error: { source: "session", code: "invalid-input" } };
  const path = read.value.path ?? "./data/sessions.sqlite"; if (typeof path !== "string" || !path || path.includes("\0")) return { ok: false, error: { source: "session", code: "invalid-input" } };
  const limits = readStorageLimits(read.value.limits); if (!limits.ok) return limits;
  return { ok: true, value: definePlugin({ name: "session-sqlite", provides: { storage: sessionStorage }, async setup(ctx) {
    const opened = await ctx.resource({ async open() {
      try { return { ok: true as const, value: openSqlStore(await openSqlite(path, limits.value.lockTimeoutMs), limits.value, 1) }; } catch { return { ok: false as const, error: { source: "session" as const, code: "storage-unavailable" as const } }; }
    }, async close(store) { const closed = await store.close(); return closed.ok ? closed : createFault("callback-failed"); } });
    return opened.ok ? ctx.service({ storage: createSqlStorage(opened.value) }) : opened;
  } }) };
}
