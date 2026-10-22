import { definePlugin } from "../../../core/src/index";
import type { Plugin } from "../../../core/src/index";
import { readData, createFault } from "../../../core/src/validation";
import { sessionStorage } from "../../session/src/storage";
import type { SessionResult } from "../../session/src/contracts";
import {
  openSqlStore,
  createSqlStorage,
  readStorageLimits,
} from "../../session-storage-sql/src/index";
import type { StorageLimits } from "../../session-storage-sql/src/index";
import { openPostgres } from "./open-postgres";

export interface PostgresSessionOptions {
  readonly url: string;
  readonly limits?: Partial<StorageLimits>;
}

export function createPostgresSessionPlugin(input: PostgresSessionOptions): SessionResult<Plugin> {
  const read = readData(input);

  if (!read.ok || Object.keys(read.value).some((key) => !["url", "limits"].includes(key)))
    return { ok: false, error: { source: "session", code: "invalid-input" } };

  const url = read.value.url;

  if (typeof url !== "string")
    return { ok: false, error: { source: "session", code: "invalid-input" } };

  try {
    if (!["postgres:", "postgresql:"].includes(new URL(url).protocol))
      return { ok: false, error: { source: "session", code: "invalid-input" } };
  } catch {
    return { ok: false, error: { source: "session", code: "invalid-input" } };
  }

  const limits = readStorageLimits(read.value.limits);

  if (!limits.ok) return limits;

  return {
    ok: true,
    value: definePlugin({
      name: "session-postgres",
      provides: { storage: sessionStorage },
      async setup(ctx) {
        const opened = await ctx.resource({
          async open() {
            try {
              return {
                ok: true as const,
                value: openSqlStore(
                  openPostgres(url, limits.value),
                  limits.value,
                  limits.value.maxConcurrent,
                ),
              };
            } catch {
              return {
                ok: false as const,
                error: { source: "session" as const, code: "storage-unavailable" as const },
              };
            }
          },
          async close(store) {
            const closed = await store.close();
            return closed.ok ? closed : createFault("callback-failed");
          },
        });
        return opened.ok ? ctx.service({ storage: createSqlStorage(opened.value) }) : opened;
      },
    }),
  };
}
