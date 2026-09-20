// delegation 只读/驱动服务面（宿主直调——不经工具 dispatch 的权限裁决与文本解析）：
// list/message/stopAll 与工具面同一动词实现（单一事实），caller = 主会话 id。
import { defineService } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";
import type { ChildView } from "./types.ts";
import type { MessageInput, VerbOutcome } from "./verbs.ts";

export interface DelegationView {
  /** caller 的子代理视图（ChildView 结构化行——原样，不铸文本；跨进程面含 discover） */
  list(caller: SessionId | undefined): Promise<readonly ChildView[]>;
  /** 开放寻址投递（agent_message 同款动词；busy → 步边界排队 / idle → 唤醒开新轮） */
  message(caller: SessionId | undefined, input: MessageInput): Promise<VerbOutcome>;
  /** 停止 caller 的全部未停子代理（abort 级联面；幂等） */
  stopAll(caller: SessionId | undefined, cause: string): Promise<void>;
}

export const delegationView = defineService<DelegationView>("delegation/view");
