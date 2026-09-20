// permission 件 token（docs/EXEC-ENV.md §0/§5）：broker 服务（宿主提供，缺席 ask 退化 deny）、
// 会话授权集服务、审计事件、围栏事实（sandbox 提供/本包消费——消费方定义 token）。

import { defineEvent, defineService } from "@x-harness/core";
import type { AskRequest, FenceFacts, PermissionAudit } from "./types.ts";

/** 人类裁决：allow/deny；无超时（宿主自治） */
export const permissionBroker = defineService<{ ask(input: AskRequest): Promise<"allow" | "deny"> }>("permission/broker");

/** 会话授权集（extraRoots/域名正负缓存/会话规则；sessionDisposed 逐出） */
export const permissionGrants = defineService<import("./grants.ts").GrantsRegistry>("permission/grants");

/** 运行期 mode 面（插件恒提供）：get 读现值（每裁决消费）；set 原子切换 decide 面
 *  mode + grants 总括授权（进入 full 即授、离开即撤——网络/extraRoots 授权面同步）。 */
export interface PermissionModeService {
  get(): import("./types.ts").ModeKnob;
  set(mode: import("./types.ts").ModeKnob): void;
}
export const permissionMode = defineService<PermissionModeService>("permission/mode");

/** 每裁决一条审计（次数断言）；会话流持久化归属 session 件 */
export const permissionDecided = defineEvent<PermissionAudit>("permission/decided", { freeze: "deep" });

/** sandbox 提供的围栏事实解析服务（fenceFor(session) 单一合成函数的暴露；无沙箱装配时缺席——
 *  bash 永不界内 auto） */
export interface FenceFactsResolver {
  forSession(session: import("@x-harness/session").SessionId | undefined): FenceFacts;
}
export const fenceFacts = defineService<FenceFactsResolver>("permission/fence-facts");
