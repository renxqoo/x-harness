import type { ThreadTable } from "./thread-table.ts";
import type { WorkerPool } from "./worker-pool.ts";

export interface SweepDeps {
  table: ThreadTable;
  pool: WorkerPool;
  limits: { idleRetireMs: number; workerStaleMs: number; rssRetireBytes: number };
}

export function createSweep(deps: SweepDeps): { start(): void; stop(): void; sweepOnce(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  const sweepOnce = (): void => {
    const now = Date.now();
    for (const entry of deps.table.list()) {
      if (entry.state !== "live") continue;
      if (now - entry.lastBeatAt > deps.limits.workerStaleMs) {
        deps.pool.killStale(entry.threadId);
        continue;
      }
      if (
        deps.limits.rssRetireBytes > 0 &&
        entry.rssBytes !== null &&
        entry.rssBytes > deps.limits.rssRetireBytes
      ) {
        if (entry.sessionPath !== null) {
          const outcome = deps.pool.retireThread(entry.threadId, "retire", "rss");
          if (outcome === "ok") {
          }
        } else {
          deps.pool.killStale(entry.threadId);
        }
        continue;
      }
      if (
        entry.sessionPath !== null &&
        !entry.keepalive &&
        entry.idleMs >= deps.limits.idleRetireMs &&
        !entry.isStreaming
      ) {
        deps.pool.retireThread(entry.threadId, "retire", "idle");
      }
    }
  };
  return {
    start() {
      if (timer === undefined) timer = setInterval(sweepOnce, 1_000);
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    sweepOnce,
  };
}
