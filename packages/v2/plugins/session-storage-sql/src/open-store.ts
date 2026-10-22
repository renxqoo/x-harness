import type { SessionResult } from "../../session/src/contracts";
import type { Database, Query, Store, StorageLimits } from "./types";
import { fail } from "./fail";
import { createStorageQueue } from "../../session/src/storage";

export function openSqlStore(database: Database, limits: StorageLimits, maximum: number): Store {
  const gate = createStorageQueue(maximum, limits.maxQueue);
  let closing: Promise<SessionResult<void>> | undefined;
  return {
    async run(input, action) {
      const entered = await gate.enter(input.signal);

      if (!entered.ok) return entered;

      const rollback = Symbol();
      let rejected: SessionResult<never> | undefined;
      const deadline = Date.now() + limits.transactionTimeoutMs;

      try {
        return await database.transaction(input.write, async (query) => {
          const check = () => {
            if (input.signal?.aborted || Date.now() >= deadline) {
              rejected = fail("cancelled");
              throw rollback;
            }
          };

          const guarded: Query = {
            textCollation: query.textCollation,
            all(text, values) {
              check();
              return query.all(text, values);
            },
            lock(key) {
              check();
              return query.lock(key);
            },
          };
          check();
          const result = await action(guarded);

          if (!result.ok) {
            rejected = result;
            throw rollback;
          }

          check();
          return result;
        });
      } catch (error) {
        return error === rollback && rejected ? rejected : fail("storage-unavailable");
      } finally {
        entered.value();
      }
    },
    close() {
      closing ??= gate.close().then(async () => {
        try {
          await database.close();
          return { ok: true, value: undefined } as const;
        } catch {
          return fail("storage-unavailable");
        }
      });
      return closing.then((result) => {
        if (!result.ok) closing = undefined;

        return result;
      });
    },
  };
}
