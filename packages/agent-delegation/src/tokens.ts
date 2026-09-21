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
