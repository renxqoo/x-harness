import type { StorageList, StorageListPage, StoredSessionSummary, StoragePolicy } from "./types";
import type { SessionResult } from "../contracts/types";
import { readStorageSummary } from "./read-summary";
import { fail } from "../domain/fail";

export function createStorageListPage(input: StorageList, policy: StoragePolicy) {
  const sessions: StoredSessionSummary[] = [];
  let bytes = 1024;
  let previous = input.after ?? "";
  let more = false;
  return {
    add(raw: unknown): SessionResult<boolean> {
      if (sessions.length >= input.limit) {
        more = true;
        return { ok: true, value: false };
      }

      const read = readStorageSummary(raw, policy);

      if (!read.ok) return read;

      const summary = read.value;

      if (summary.id <= previous) return fail("storage-corrupt");

      const size = new TextEncoder().encode(summary.metadata).length * 2 + 512;

      if (bytes + size > input.maxPageBytes) {
        if (!sessions.length) return fail("record-too-large");

        more = true;
        return { ok: true, value: false };
      }

      bytes += size;
      previous = summary.id;
      sessions.push(summary);
      return { ok: true, value: true };
    },
    finish(): StorageListPage {
      return Object.freeze({
        sessions: Object.freeze(sessions),
        ...(more ? { next: previous } : {}),
      });
    },
  };
}
