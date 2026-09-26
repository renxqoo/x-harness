// delegation 只读/驱动服务面（宿主直调——不经工具 dispatch 的权限裁决与文本解析）：
// list/message/stopAll 与工具面同一动词实现（单一事实），caller = 主会话 id。
import { defineService } from "@x-harness/core";
import type { ChildView } from "./types.ts";
import type { MessageInput, VerbOutcome } from "./verbs.ts";
import type { SessionId } from "@x-harness/session";
import type { SettlementSink } from "./tokens.ts";
import type { SpawnInput, SpawnOutcome } from "./spawn.ts";
import type { ReviveOutcome } from "./revive.ts";

export interface DelegationView {
  /** caller 的子代理视图（ChildView 结构化行——原样，不铸文本；跨进程面含 discover） */
  list(caller: SessionId | undefined): Promise<readonly ChildView[]>;
  /** 开放寻址投递（agent_message 同款动词；busy → 步边界排队 / idle → 唤醒开新轮） */
  message(caller: SessionId | undefined, input: MessageInput): Promise<VerbOutcome>;
  /** 停止 caller 的全部未停子代理（abort 级联面；幂等；受管行豁免——§6 接缝④） */
  stopAll(caller: SessionId | undefined, cause: string): Promise<void>;
  /** 宿主 REPL 会话切换（/new、/resume）后重绑跨进程邮箱：换箱 + 换信封路由目的地。
   *  mailbox 缺席部署拒 invalid-args；新箱开失败如实失败（保持旧绑定）。 */
  rebindMailbox(next: SessionId): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 服务面 spawn（件16 接缝①）：与 agent_spawn 工具同一决策流（深度/并发门/worktree/白名单）；
   *  settlement 在场 = 受管行。服务面无 execCtx——内部合成 AbortSignal。 */
  spawnManaged(caller: SessionId, input: Omit<SpawnInput, "description"> & { readonly description: string }): Promise<SpawnOutcome>;
  /** 服务面复活（件16 接缝②）：按 agentId 重建 lineage 行（message 复活链同源）；
   *  settlement 在场 = 重建为受管行（B2-01——不带则恢复行绕过验收）。 */
  reviveManaged(caller: SessionId, agentId: string, settlement?: SettlementSink): Promise<ReviveOutcome>;
  /** 受管行终局归还（件16 接缝③）：cancel → whenIdle → dispose → worktree 清理 → 摘行——
   *  workflow settle 的唯一归还面（stopAll 误杀同父直通子，故单行动词）。 */
  settle(agentId: string, cause: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export const delegationView = defineService<DelegationView>("delegation/view");
