// bash 任务完成通知臂（docs/TASK-PUSH-DESIGN.md §2.4）：onSettled → 读日志尾部 →
// loop.get(session).notify("bash-task", "content", 铸文)。与 agent-delegation 的
// [agent-notification] 同构：next-step 排队 + 唤醒（busy 亲会话步边界消费）、材料化
// agent/message、UI 不当用户发言、压缩摘要保留。全部终态都通知（含 stop 杀——与 agent
// 源「stop 后通知如实送达」同构，无特例分支）。通知是「到货铃」非全文载体：尾部小帽 +
// 日志路径，全文在读面（read/grep 日志文件）。

import { open } from "node:fs/promises";
import type { AgentLoopService } from "@x-harness/agent-loop";
import type { SessionId } from "@x-harness/session";
import type { TaskSnapshot } from "@x-harness/tool-bash";
import { stateLine } from "./cast.ts";

/** 通知正文 source（与 DELEGATION_REPORT_SOURCE 同款登记——docs/AGENT-MESSAGE.md）：
 *  材料化为 agent/message{kind:content}——模型可见（投影 user 角色）、UI 不当用户发言 */
export const BASH_TASK_NOTIFY_SOURCE = "bash-task";

/** 尾部切片帽（字节——首尾均 UTF-8 边界对齐；全文在读面，通知只带到货证据） */
const TAIL_CAP_BYTES = 4_096;

export interface BashNotifierDeps {
  readonly loop: AgentLoopService;
  /** 丢弃/读失败留痕（缺省 stderr——对齐 core 监听器错误缺省 sink） */
  readonly onWarn?: (message: string) => void;
}

/** 读日志尾部：不整文件读入（64MB 放大不可接受）；起始点落在多字节字符中间时回退到
 *  字符边界（结果 ≤ 帽）；读失败（文件被清理等）返回空串——通知仍发，路径行即指针 */
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
      if (start0 > 0) while (begin < length && ((buf[begin] as number) & 0xc0) === 0x80) begin += 1; // 头部续字节回退
      let end = length;
      while (end > begin && ((buf[end] as number) & 0xc0) === 0x80) end -= 1; // 尾部防御性对齐
      return buf.subarray(begin, end).toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}

/** 通知铸文：首行（与 stop 回执 stateLine 同口径）+ 日志路径 + 帽/写失败注记 + 尾部切片 */
export function taskNotificationText(snap: TaskSnapshot, tail: string): string {
  const lines = [`[task-notification] ${stateLine(snap)}`, `log: ${snap.logPath}`];
  if (snap.truncated) lines.push(`(output hit the write cap; ${String(snap.droppedBytes)} bytes dropped — read the log for the retained prefix)`);
  if (snap.writeError !== undefined) lines.push(`log incomplete (write error: ${snap.writeError})`);
  if (tail !== "") lines.push(`--- last ${String(Buffer.byteLength(tail))} bytes ---`, tail);
  return lines.join("\n");
}

/** onSettled listener：匿名/句柄缺席丢弃（文件仍在盘，通知非唯一载体）；投递失败留痕
 *  （父恰在封存——同 delegation deliver 口径） */
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
        handle.agent.notify(BASH_TASK_NOTIFY_SOURCE, "content", taskNotificationText(snap, tail));
      } catch (error) {
        warn(`bash-task notify dropped for '${snap.id}': ${String(error)}`);
      }
    })().catch((error: unknown) => {
      warn(`bash-task notify failed for '${snap.id}': ${String(error)}`);
    });
  };
}
