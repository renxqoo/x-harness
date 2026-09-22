// 内部消息子系统单一真相（docs/AGENT-MESSAGE.md）：harness → 模型的注入消息——
// 模型可见（投影 user 角色）、UI 按类型隐藏（类型白名单，非标记）、压缩按 kind 分流。
// 构造器与消费谓词全部经本模块；消费方禁止按 source 分支、禁止自定义 kind 判断。

import type { ContentBlock, SessionEvent, SessionEventData } from "./types.ts";

/** kind 闭集（docs/AGENT-MESSAGE.md §1）：判定问题 =「压缩后模型还需要记得吗」——
 *  directive = 指令（告诉模型怎么做，照做完作废 → 摘要跳过）；
 *  content = 内容（事实/结果，压缩后必须存活 → 摘要保留）。
 *  扩闭集走子系统修订程序（§4 场景 B——独立小方案），禁止顺手扩。 */
export const AGENT_MESSAGE_KINDS: ReadonlySet<string> = new Set(["directive", "content"]);

export type AgentMessageKind = "directive" | "content";

export interface AgentMessageInput {
  readonly turn: number;
  readonly step: number;
  /** 来源标签（开放词表·写入方命名空间纪律 "<域>-<含义>"，如 output-continuation）——
   *  只作诊断与写入方自引用（计数折叠），消费方禁止按 source 分支 */
  readonly source: string;
  readonly kind: AgentMessageKind;
  /** 模型可见内容（text-only 起步——image 通道按需后开，扩词表走 §4 场景 B 程序） */
  readonly content: readonly ContentBlock[];
}

/** data 构造器（形状单一出口——内核/插件/宿主三级写入共用，docs/AGENT-MESSAGE.md §2） */
export function agentMessageData(input: AgentMessageInput): SessionEventData["agent/message"] {
  return { turn: input.turn, step: input.step, source: input.source, kind: input.kind, content: [...input.content] };
}

export type AgentMessageEvent = SessionEvent<"agent/message">;

/** 消费谓词：directive（摘要跳过——serialize 等消费方用，不自定义 kind 判断） */
export function isAgentDirective(event: SessionEvent): boolean {
  return event.type === "agent/message" && event.data.kind === "directive";
}

/** 消费谓词：content（摘要保留为内容行） */
export function isAgentContent(event: SessionEvent): boolean {
  return event.type === "agent/message" && event.data.kind === "content";
}
