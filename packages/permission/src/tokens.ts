// permission 件 token（docs/PERMISSION-V2-DESIGN.md §6）：broker 服务（结构化 ask 往返——
// 宿主提供，缺席 ask 退化 deny）、会话授权集服务、持久学习写入面（宿主提供 settings
// 持久化；缺席则 project/user 记忆选项降级）、审计事件、围栏事实（sandbox 提供/本包消费）。

import { defineEvent, defineService } from "@x-harness/core";
import type { AskPayload, AskReply, PermissionAudit, RuleEntry } from "./types.ts";

/** 人类裁决：结构化应答（布尔退化形态=allow-once/deny）；无超时（宿主自治） */
export const permissionBroker = defineService<{ ask(input: AskPayload): Promise<AskReply> }>("permission/broker");

/** 持久学习写入面（宿主提供——host-hub settings 落盘；CLI 可缺席）：scope 对应设置文件；
 *  失败即该作用域记忆不可用（不降级写别处）。 */
export const permissionGrantStore = defineService<{
  write(scope: "project" | "user", entry: RuleEntry): Promise<{ ok: true } | { ok: false; reason: string }>;
}>("permission/grant-store");

/** 会话授权集（extraRoots/域名正负缓存/会话习得规则；sessionDisposed 逐出） */
export const permissionGrants = defineService<import("./grants.ts").GrantsRegistry>("permission/grants");

/** 运行期档位面（插件恒提供）：get 读现值（每裁决消费）；set 原子切换 decide 面
 *  档位 + grants 总括授权（进入 full 即授、离开即撤——网络/extraRoots 授权面同步）。 */
export interface PermissionModeService {
  get(): import("./types.ts").ProfileId;
  set(mode: import("./types.ts").ProfileId): void;
}
export const permissionMode = defineService<PermissionModeService>("permission/mode");

/** 每裁决一条审计（次数断言；exec 指令与命中来源随行）；会话流持久化归属 session 件 */
export const permissionDecided = defineEvent<PermissionAudit>("permission/decided", { freeze: "deep" });

/** 习得规则写入审计（作用域+规则串+来源命令摘要——管理面/对账用） */
export const permissionGrantWritten = defineEvent<{ readonly scope: "session" | "project" | "user"; readonly rule: string; readonly from: string }>("permission/grant-written", {
  freeze: "deep",
});

/** sandbox 提供的围栏事实解析服务（fenceFor(session) 单一合成函数的暴露；无沙箱装配时缺席——
 *  bash 界内合成写判定由分类器接管） */
export interface FenceFactsResolver {
  forSession(session: import("@x-harness/session").SessionId | undefined): import("./types.ts").FenceFacts;
}
export const fenceFacts = defineService<FenceFactsResolver>("permission/fence-facts");
