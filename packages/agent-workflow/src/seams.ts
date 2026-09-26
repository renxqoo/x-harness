// 受管任务接线（件16 §6 接缝消费面）：settlement sink 铸造 + agentId 解析。

import type { SessionId } from "@x-harness/session";
import type { ManagedCycleReport, SettlementSink } from "@x-harness/agent-delegation";
import type { ManagedReport, ManagedTaskRef } from "./types.ts";

/** settlement sink：受管投递转发到 runtime.onCycleEnd（同步转发——throw 冒泡给
 *  delegation 兜底回收，W8 第五条的触发点） */
export function settlementOf(task: ManagedTaskRef, onCycleEnd: (task: ManagedTaskRef, report: ManagedReport) => Promise<void>): SettlementSink {
  return {
    onCycleEnd: (report: ManagedCycleReport) => {
      const managed: ManagedReport = {
        agentId: report.agentId,
        sessionId: report.sessionId,
        outcome: report.outcome,
        detail: report.detail,
        ...(report.summary !== undefined ? { summary: report.summary } : {}),
      };
      void onCycleEnd(task, managed).catch(() => {
        // settlement 失败（journal 写失败/回调 throw）：rethrow 由 delegation 兜底回收——
        // 异步转发无法同步冒泡，改为吞掉（delegation 侧投递即完成）；run 停在当前事件，
        // 下次恢复边沿按窗口表收敛（F1 的恢复侧兜底）
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

/** sessionId 提取（"session <id>"） */
export function sessionOfManaged(spawnText: string): SessionId {
  const hit = /session ([A-Za-z0-9._-]+)/.exec(spawnText);
  if (hit === null) throw new Error(`no session in spawn result: ${spawnText.slice(0, 80)}`);
  return hit[1] as SessionId;
}
