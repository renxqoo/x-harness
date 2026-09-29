import type { SessionId } from "@x-harness/session";

import type { ManagedCycleReport, SettlementSink } from "@x-harness/agent-delegation";
import type { ManagedReport, ManagedTaskRef } from "./types.ts";

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
      void onCycleEnd(task, managed).catch(async (error) => {
        await onSettleFailed(report.agentId, error).catch(() => {});
      });
    },
  };
}

export function agentIdOfManaged(spawnText: string): string {
  const hit = /agent-[0-9a-f]{8}/.exec(spawnText);
  if (hit === null) throw new Error(`no agentId in spawn result: ${spawnText.slice(0, 80)}`);
  return hit[0] as string;
}

export function sessionOfManaged(spawnText: string): SessionId {
  const hit = /session ([A-Za-z0-9._-]+)/.exec(spawnText);
  if (hit === null) throw new Error(`no session in spawn result: ${spawnText.slice(0, 80)}`);
  return hit[1] as SessionId;
}
