// 巡逻 sweep（DESIGN §7）：1s 一拍——心跳陈旧杀（宁可杀错）；RSS 硬顶处置
// （已落盘 retire / 未落盘 kill——无文件可保的表项不得进 parked）；idle retire
// （keepalive/busy 例外——busy 已由 worker 的 idleMs=0 表达；在跑直执行 bash 同由
// worker busy 覆盖）。spawn 截止与拆除死线由 pool/retireThread 自持。
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
        deps.pool.killStale(entry.threadId); // 宁可杀错：close 结算 dead + thread_died
        continue;
      }
      if (
        deps.limits.rssRetireBytes > 0 &&
        entry.rssBytes !== null &&
        entry.rssBytes > deps.limits.rssRetireBytes
      ) {
        // RSS 硬顶：无视 keepalive/busy（机器保护优先）；未落盘走 kill（thread_died）
        if (entry.sessionPath !== null) {
          const outcome = deps.pool.retireThread(entry.threadId, "retire", "rss");
          if (outcome === "ok") {
            // close 结算发 thread_parked(reason=rss)
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
