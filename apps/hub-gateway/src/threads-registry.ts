import { readFile } from "node:fs/promises";
import { atomicWrite } from "./identity.ts";

export interface ThreadEntry {
  threadId: string;
  sessionPath: string;
  epoch: number;
  createdAt: number;
  lastSeenAt: number;
}

export interface ThreadsRegistry {
  all(): ThreadEntry[];
  upsert(spec: { threadId: string; sessionPath: string }): ThreadEntry;
  remove(threadId: string): boolean;
  get(threadId: string): ThreadEntry | null;
  bumpEpoch(threadId: string): number | null;
}

export async function loadThreads(path: string): Promise<ThreadsRegistry> {
  let entries: ThreadEntry[] = [];
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { threads?: unknown };
    if (Array.isArray(raw.threads)) {
      entries = raw.threads.filter(
        (t): t is ThreadEntry =>
          typeof t === "object" && t !== null && typeof (t as ThreadEntry).threadId === "string" && typeof (t as ThreadEntry).sessionPath === "string",
      );
    }
  } catch {
    entries = [];
  }
  const map = new Map(entries.map((e) => [e.threadId, e]));
  let writeTail: Promise<void> = Promise.resolve();
  const flush = (): Promise<void> => {
    writeTail = writeTail.then(() => atomicWrite(path, JSON.stringify({ threads: [...map.values()] }, null, 2)));
    return writeTail;
  };
  await flush();
  return {
    all: () => [...map.values()],
    upsert(spec) {
      const existing = map.get(spec.threadId);
      const now = Date.now();
      const entry: ThreadEntry = existing
        ? { ...existing, sessionPath: spec.sessionPath, lastSeenAt: now }
        : { threadId: spec.threadId, sessionPath: spec.sessionPath, epoch: 1, createdAt: now, lastSeenAt: now };
      map.set(spec.threadId, entry);
      void flush();
      return entry;
    },
    remove(threadId) {
      const hit = map.delete(threadId);
      void flush();
      return hit;
    },
    get: (threadId) => map.get(threadId) ?? null,
    bumpEpoch(threadId) {
      const entry = map.get(threadId);
      if (entry === undefined) return null;
      entry.epoch += 1;
      entry.lastSeenAt = Date.now();
      map.set(threadId, entry);
      void flush();
      return entry.epoch;
    },
  };
}
