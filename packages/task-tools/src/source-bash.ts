import type { BackgroundTasks, TaskSnapshot } from "@x-harness/tool-bash";
import type { SessionId } from "@x-harness/session";
import type { TaskSource } from "./tokens.ts";
import { stateLine } from "./cast.ts";

const SETTLE_POLL_MS = 25;
const STOP_SETTLE_BUDGET_MS = 13_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

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
    probe: (taskId, caller) => (tasks.list(caller).some((t) => t.id === taskId) ? { kind: "hit" } : { kind: "miss" }),
    stop: async (taskId, caller) => {
      const initiated = tasks.stop(caller, taskId);
      if (!initiated.ok) return { ok: false, reason: `not-found:${taskId}` };
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
