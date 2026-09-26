// 子代理生命周期事件（BATCH2-DESIGN §3）：realtime 边沿（freeze:none，不进 WAL——
// 状态快照读口是 delegationView.list，事件是增量推送；两源对账：重连先快照再订阅）。

import { defineEvent } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";

/** spawn 成功（lineage 登记后）与 revive 复活注册两处发射——桥接方据此播种
 *  session→agentId 归属映射（agentName 面） */
export interface AgentSpawnedPayload {
  readonly parent: SessionId;
  readonly agentId: string;
  readonly sessionId: SessionId;
  readonly type: string;
  readonly depth: number;
  /** spawn 任务摘要（与 get_subagents ChildView.work 同源）；复活发射可能缺席（旧档案无此字段） */
  readonly work?: string;
}

/** 运行周期终结边沿：**每运行周期恰一次**（非生命周期终态——stop 后可复活，复活再
 *  运行会再发）。outcome：completed=正常完成；stopped=取消（aborted 映射）；其余终态
 *  （error/interrupted/max-tokens/blocked）= failed。detail = failureDetail 词表句 */
export interface AgentFinishedPayload {
  readonly parent: SessionId;
  readonly agentId: string;
  readonly sessionId: SessionId;
  readonly outcome: "completed" | "stopped" | "failed";
  readonly detail: string;
  readonly summary?: string;
}

export const agentSpawned = defineEvent<AgentSpawnedPayload>("agent/spawned", { freeze: "none" });

export const agentFinished = defineEvent<AgentFinishedPayload>("agent/finished", { freeze: "none" });

// ————————————————————————— 件16：受管结算（docs/AGENT-WORKFLOW.md §6 接缝） —————————————————————————

/** 受管子代理的结算入口（不透明 token——workflow 铸造、delegation 只回调不解读）。
 *  生命周期约定（§6 接缝④）：settlement 在场期间，孤儿收养/档化/级联清理豁免；
 *  投递 throw = settle 失联 → delegation 兜底回收（W8 第五条）。 */
export interface SettlementSink {
  /** 子代理运行周期终结边沿（agentFinished 同源事实 + 完整报告——受管路径不走父 notify） */
  onCycleEnd(report: ManagedCycleReport): void;
}

/** 受管投递报告：agentFinished payload 超集（报告全文直送，截断归 sink） */
export interface ManagedCycleReport {
  readonly parent: SessionId;
  readonly agentId: string;
  readonly sessionId: SessionId;
  /** completed / stopped / failed（与 AgentFinishedPayload.outcome 同口径） */
  readonly outcome: "completed" | "stopped" | "failed";
  readonly detail: string;
  /** 末轮 assistant 全文（未截断——截断归 sink；缺席 = 无报告） */
  readonly summary?: string;
  readonly usage?: unknown;
}
