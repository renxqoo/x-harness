import { NON_LIVE_TABLE_CAP } from "../shared/limits.ts";

export type ThreadState = "spawning" | "live" | "retiring" | "parked" | "dead";

export interface ThreadEntry {
  threadId: string;
  cwd: string;
  sessionPath: string | null;
  state: ThreadState;
  trusted: boolean;
  keepalive: boolean;
  isStreaming: boolean;
  idleMs: number;
  rssBytes: number | null;
  retireIntent: "stop" | "retire" | undefined;
  lastBeatAt: number;
}

export function createThreadTable() {
  const entries = new Map<string, ThreadEntry>();
  const occupiedPaths = new Map<string, string>();
  const fifo: string[] = [];

  function evictNonLive(): void {
    while (fifo.length > 0 && entries.size >= NON_LIVE_TABLE_CAP + liveCount()) {
      const oldest = fifo.shift();
      if (oldest === undefined) break;
      const entry = entries.get(oldest);
      if (entry === undefined || entry.state === "live" || entry.state === "spawning" || entry.state === "retiring") {
        continue;
      }
      releaseOccupancy(oldest);
      entries.delete(oldest);
    }
  }

  function pushFifo(threadId: string): void {
    if (!fifo.includes(threadId)) fifo.push(threadId);
  }

  function liveCount(): number {
    let n = 0;
    for (const entry of entries.values()) {
      if (entry.state === "live" || entry.state === "spawning" || entry.state === "retiring") n += 1;
    }
    return n;
  }

  function releaseOccupancy(threadId: string): void {
    const entry = entries.get(threadId);
    if (entry === undefined) return;
    if (entry.sessionPath === null) return;
    for (const [path, owner] of occupiedPaths) {
      if (owner === threadId) occupiedPaths.delete(path);
    }
  }

  return {
    get(threadId: string): ThreadEntry | undefined {
      return entries.get(threadId);
    },
    list(): ThreadEntry[] {
      return [...entries.values()];
    },
    liveCount,
    holderOf(sessionPath: string): string | undefined {
      return occupiedPaths.get(sessionPath);
    },
    insert(entry: Omit<ThreadEntry, "isStreaming" | "idleMs" | "rssBytes" | "retireIntent" | "lastBeatAt">): ThreadEntry {
      const full: ThreadEntry = {
        ...entry,
        isStreaming: false,
        idleMs: 0,
        rssBytes: null,
        retireIntent: undefined,
        lastBeatAt: Date.now(),
      };
      entries.set(full.threadId, full);
      if (full.sessionPath !== null) {
        occupiedPaths.set(full.sessionPath, full.threadId);
      }
      if (full.state !== "live") pushFifo(full.threadId);
      evictNonLive();
      return full;
    },
    update(threadId: string, patch: Partial<ThreadEntry>): ThreadEntry | undefined {
      const entry = entries.get(threadId);
      if (entry === undefined) return undefined;
      const wasLive = entry.state === "live" || entry.state === "spawning" || entry.state === "retiring";
      const previousPath = entry.sessionPath;
      Object.assign(entry, patch);
      if (patch.sessionPath !== undefined && patch.sessionPath !== previousPath) {
        if (previousPath !== null) occupiedPaths.delete(previousPath);
        if (patch.sessionPath !== null) occupiedPaths.set(patch.sessionPath, threadId);
      }
      const isLive = entry.state === "live" || entry.state === "spawning" || entry.state === "retiring";
      if (wasLive && !isLive) pushFifo(threadId);
      return entry;
    },
    applyHeartbeat(threadId: string, beat: { idleMs: number; streaming: boolean; sessionPath: string | null; rssBytes: number | null }): void {
      const entry = entries.get(threadId);
      if (entry === undefined) return;
      entry.idleMs = beat.idleMs;
      entry.isStreaming = beat.streaming;
      const sample = Number.isFinite(beat.rssBytes) ? beat.rssBytes : null;
      entry.rssBytes = sample;
      entry.lastBeatAt = Date.now();
      if (beat.sessionPath !== null && beat.sessionPath !== entry.sessionPath) {
        if (entry.sessionPath !== null) occupiedPaths.delete(entry.sessionPath);
        entry.sessionPath = beat.sessionPath;
        occupiedPaths.set(beat.sessionPath, threadId);
      }
    },
    rekey(previousThreadId: string, next: { threadId: string; sessionPath: string; cwd: string; trusted: boolean; state: ThreadState }): void {
      releaseOccupancy(previousThreadId);
      entries.delete(previousThreadId);
      this.insert({ ...next, keepalive: false });
    },
    remove(threadId: string): void {
      releaseOccupancy(threadId);
      entries.delete(threadId);
    },
  };
}

export type ThreadTable = ReturnType<typeof createThreadTable>;
