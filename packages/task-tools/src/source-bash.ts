// bash 源适配（docs/TASKS.md §3 + docs/TASK-PUSH-DESIGN.md §2.1）：BackgroundTasks 句柄 →
// TaskSource（stop 单动词；读面归日志文件与 [task-notification]）。
// 外置 waitSettled 收敛（判据 endedAt——finalize 唯一收口，防 mid-kill 撕裂快照）。
// tool-bash 零改动：全部经公开句柄（list/stop）达成。

import type { BackgroundTasks, TaskSnapshot } from "@x-harness/tool-bash";
import type { SessionId } from "@x-harness/session";
import type { TaskSource } from "./tokens.ts";
import { stateLine } from "./cast.ts";

const SETTLE_POLL_MS = 25;
/** stop 收敛预算 = TERM → KILL_GRACE（tool-bash bash.ts 内 5s）→ KILL + 8s 余量上界；
 *  tool-bash 零改动约束下不 import 其私有常量，改值时两处同变 */
const STOP_SETTLE_BUDGET_MS = 13_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/** 内存轮询至 finalize 产物：轮询面用 list() 而非读日志——list 只读 rec 字段不碰文件。
 *  返回 settle 后快照；超时回当前（乐观态）快照；id 从 list 消失（evict 竞态）= undefined */
interface SettleQuery {
  readonly tasks: BackgroundTasks;
  readonly session: SessionId | undefined;
  readonly id: string;
  readonly timeoutMs: number;
}

async function waitSettled(query: SettleQuery): Promise<TaskSnapshot | undefined> {
  const deadline = Date.now() + Math.max(0, query.timeoutMs);
  for (;;) {
    const snap = query.tasks.list(query.session).find((t) => t.id === query.id);
    if (snap === undefined || snap.endedAt !== undefined) return snap;
    if (Date.now() >= deadline) return snap;
    await sleep(SETTLE_POLL_MS);
  }
}

export function bashTaskSource(tasks: BackgroundTasks): TaskSource {
  return {
    kind: "bash",
    // probe 走 list()（会话键控即属主面）
    probe: (taskId, caller) => (tasks.list(caller).some((t) => t.id === taskId) ? { kind: "hit" } : { kind: "miss" }),
    stop: async (taskId, caller) => {
      // 发起返回的同步快照即「发起时是否已终态」的无竞态答案（晚一拍的自然完成归 Stopped 属实）
      const initiated = tasks.stop(caller, taskId);
      if (!initiated.ok) return { ok: false, reason: `not-found:${taskId}` }; // 发起期 404（迟到 miss——路由层回落统一词表）
      const alreadyFinished = initiated.value.endedAt !== undefined;
      const settled = await waitSettled({ tasks, session: caller, id: taskId, timeoutMs: STOP_SETTLE_BUDGET_MS });
      const snap = settled ?? tasks.list(caller).find((t) => t.id === taskId);
      if (snap === undefined) return { ok: false, reason: `not-found:${taskId}` };
      const prefix = alreadyFinished ? "already finished" : "Stopped";
      const midKill = snap.endedAt === undefined ? " (still settling — mid-kill snapshot)" : "";
      return { ok: true, text: `${prefix} ${stateLine(snap)}${midKill}` };
    },
  };
}
