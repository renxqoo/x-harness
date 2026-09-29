import { open } from "node:fs/promises";
import type { AgentLoopService } from "@x-harness/agent-loop";
import type { SessionId } from "@x-harness/session";
import type { TaskSnapshot } from "@x-harness/tool-bash";
import { stateLine } from "./cast.ts";

export const BASH_TASK_NOTIFY_SOURCE = "bash-task";

const TAIL_CAP_BYTES = 4_096;

export interface BashNotifierDeps {
  readonly loop: AgentLoopService;
  readonly onWarn?: (message: string) => void;
}

export async function readTail(logPath: string, capBytes: number): Promise<string> {
  try {
    const fh = await open(logPath, "r");
    try {
      const size = (await fh.stat()).size;
      if (size === 0) return "";
      const start0 = Math.max(0, size - capBytes);
      const length = size - start0;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start0);
      let begin = 0;
      if (start0 > 0) while (begin < length && ((buf[begin] as number) & 0xc0) === 0x80) begin += 1;
      let end = length;
      while (end > begin && ((buf[end] as number) & 0xc0) === 0x80) end -= 1;
      return buf.subarray(begin, end).toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}

export function taskNotificationText(snap: TaskSnapshot, tail: string): string {
  const lines = [`[task-notification] ${stateLine(snap)}`, `log: ${snap.logPath}`];
  if (snap.truncated) lines.push(`(output hit the write cap; ${String(snap.droppedBytes)} bytes dropped — read the log for the retained prefix)`);
  if (snap.writeError !== undefined) lines.push(`log incomplete (write error: ${snap.writeError})`);
  if (tail !== "") lines.push(`--- last ${String(Buffer.byteLength(tail))} bytes ---`, tail);
  return lines.join("\n");
}

export function createBashTaskNotifier(deps: BashNotifierDeps): (snap: TaskSnapshot) => void {
  const warn = deps.onWarn ?? ((message: string) => {
    process.stderr.write(`[x-harness] task-tools: ${message}\n`);
  });
  return (snap) => {
    if (snap.session === undefined) return;
    const handle = deps.loop.get(snap.session as SessionId);
    if (handle === undefined) return;
    void (async () => {
      const tail = await readTail(snap.logPath, TAIL_CAP_BYTES);
      try {
        handle.agent.notify({ source: BASH_TASK_NOTIFY_SOURCE, kind: "content", text: taskNotificationText(snap, tail) });
      } catch (error) {
        warn(`bash-task notify dropped for '${snap.id}': ${String(error)}`);
      }
    })().catch((error: unknown) => {
      warn(`bash-task notify failed for '${snap.id}': ${String(error)}`);
    });
  };
}
