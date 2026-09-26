import type { SessionId } from "@x-harness/session";
// 受管任务接线（件16 §6 接缝消费面）：settlement sink 铸造 + agentId 解析。

import type { ManagedCycleReport, SettlementSink } from "@x-harness/agent-delegation";
import type { ManagedReport, ManagedTaskRef } from "./types.ts";

/** settlement sink：受管投递转发到 runtime.onCycleEnd（同步转发——throw 冒泡给
 *  delegation 兜底回收，W8 第五条的触发点） */
export function settlementOf(
  task: ManagedTaskRef,
  onCycleEnd: (task: ManagedTaskRef, report: ManagedReport) => Promise<void>,
  onSettleFailed: (agentId: string, error: unknown) => Promise<void>,
): SettlementSink {
  return {
    onCycleEnd: (report: ManagedCycleReport) => {
      const managed: ManagedReport = {
        agentId: report.agentId,
        sessionId: report.sessionId,
        outcome: report.outcome,
        detail: report.detail,
        ...(report.summary !== undefined ? { summary: report.summary } : {}),
      };
      // D5 修：投递失败显式兜底（不再静默吞——W8 第五条的兑现）：受管行 settle 归还
      // + onWarn。journal 侧由下次恢复边沿按窗口表收敛（run 停在当前事件）。
      void onCycleEnd(task, managed).catch(async (error) => {
        await onSettleFailed(report.agentId, error).catch(() => {});
      });
    },
  };
}

/** spawnManaged 返回文本中的 agentId 提取（"Spawned agent-xxxxxxxx ..."） */
export function agentIdOfManaged(spawnText: string): string {
  const hit = /agent-[0-9a-f]{8}/.exec(spawnText);
  if (hit === null) throw new Error(`no agentId in spawn result: ${spawnText.slice(0, 80)}`);
  return hit[0] as string;
}

/** sessionId 提取（"session <id>"）——恢复链读子会话档案的锚 */
export function sessionOfManaged(spawnText: string): SessionId {
  const hit = /session ([A-Za-z0-9._-]+)/.exec(spawnText);
  if (hit === null) throw new Error(`no session in spawn result: ${spawnText.slice(0, 80)}`);
  return hit[1] as SessionId;
}
