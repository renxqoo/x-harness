// bash 源适配（docs/TASKS.md §3）：BackgroundTasks 句柄 → TaskSource；外置 waitSettled
// 收敛（判据 endedAt——finalize 唯一收口，防 mid-kill 撕裂快照）。tool-bash 零改动：
// 全部经公开句柄（read/list/stop）达成。

import type { BackgroundTasks, TaskRead, TaskSnapshot } from "@x-harness/tool-bash";
import type { SessionId } from "@x-harness/session";
import type { TaskSource } from "./tokens.ts";

const COMMAND_CAP = 80;
const SETTLE_POLL_MS = 25;
const WAIT_DEFAULT_MS = 30_000;
/** stop 收敛预算 = TERM → KILL_GRACE（tool-bash bash.ts 内 5s）→ KILL + 8s 余量上界；
 *  tool-bash 零改动约束下不 import 其私有常量，改值时两处同变 */
const STOP_SETTLE_BUDGET_MS = 13_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

function commandHead(command: string): string {
  return command.length > COMMAND_CAP ? `${command.slice(0, COMMAND_CAP)}…` : command;
}

function exitText(code: number | null): string {
  return code === null ? "null" : String(code);
}

/** 终态行：state/exit 一段式（stop 与 output 共用口径） */
function stateLine(snap: TaskSnapshot): string {
  return `task ${snap.id} (${commandHead(snap.command)}): ${snap.state} exit=${exitText(snap.exitCode)} bytes=${String(snap.bytes)}`;
}

/** bash 读铸文：头行 + 切片 + 尾注（nextOffset/more 驱动增量读；truncated/spill 全文提示） */
export function bashReadText(read: TaskRead): string {
  const s = read.snapshot;
  const tail = [`nextOffset=${String(read.nextOffset)}; more=${read.more ? "true" : "false"}`];
  if (s.truncated) tail.push(`output hit the retention cap${s.spillPath !== undefined ? `; full retained output: ${s.spillPath}` : ""}`);
  return `${stateLine(s)}\n${read.text}\n${tail.join("; ")}`;
}

/** 内存轮询至 finalize 产物：轮询面用 list() 而非 read()——read 每次 Buffer.from(full)
 *  全量重编码保留缓冲（64MB fullCap × 25ms 粒度不可接受），list 只读 rec 字段不碰缓冲。
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
    // probe-by-read（offset 0 纯查询无副作用）；会话键控即属主面——越权即 miss
    probe: (taskId, caller) => (tasks.read(caller, taskId, 0).ok ? { kind: "hit" } : { kind: "miss" }),
    output: async (taskId, caller, opts) => {
      const timeout = opts.timeout ?? WAIT_DEFAULT_MS;
      if ((opts.block ?? true) && timeout > 0) await waitSettled({ tasks, session: caller, id: taskId, timeoutMs: timeout }); // timeout=0 = 零等待立即快照
      const read = tasks.read(caller, taskId, opts.offset ?? 0);
      return read.ok ? { ok: true, text: bashReadText(read.value) } : { ok: false, reason: `not-found:${taskId}` };
    },
    stop: async (taskId, caller) => {
      const before = tasks.list(caller).find((t) => t.id === taskId);
      const initiated = tasks.stop(caller, taskId);
      if (!initiated.ok) return { ok: false, reason: `not-found:${taskId}` }; // 发起期 404（迟到 miss——路由层回落统一词表）
      const settled = await waitSettled({ tasks, session: caller, id: taskId, timeoutMs: STOP_SETTLE_BUDGET_MS });
      const snap = settled ?? tasks.list(caller).find((t) => t.id === taskId);
      if (snap === undefined) return { ok: false, reason: `not-found:${taskId}` };
      const prefix = before !== undefined && before.endedAt !== undefined ? "already finished" : "Stopped"; // 发起前已终态：裸 Stopped 是谎言
      const midKill = snap.endedAt === undefined ? " (still settling — mid-kill snapshot)" : "";
      return { ok: true, text: `${prefix} ${stateLine(snap)}${midKill}` };
    },
  };
}
