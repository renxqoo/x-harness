// Agent-Loop 契约类型（docs/AGENT-LOOP-DRIVER.md §1.1）。

import type { Result } from "@x-harness/core";
import type { ImageBlock, Session, SessionId, CreateSessionOptions } from "@x-harness/session";
import type { ThinkingLevel } from "@x-harness/llm";

export interface AgentOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** 思考等级（缺省/off = 不发 thinking 参数）；随 Dial 折叠与 request/header 落账 */
  readonly thinking?: ThinkingLevel;
  /** 静态系统提示词：优先于 systemPrompt.assemble() */
  readonly systemPrompt?: string;
  /** 并行工具池上限（默认 10） */
  readonly maxParallelToolCalls?: number;
  /** tool/result 落账前截断（默认 100_000，尾标 …[truncated]） */
  readonly maxToolResultChars?: number;
  /** 流空闲看门狗毫秒（默认 300_000；≤0 关闭）：相邻 chunk 间隔超时 → 注入
   *  finish{error,code:network} 走既有 llm-retry 重拨——静默挂死变有界失败。
   *  与取消语义无关（不触碰 turn 级 signal）；子代理经 childAgentOptions 透传 */
  readonly streamIdleTimeoutMs?: number;
  /** 工具白名单（名字集；缺省=全部注册工具）——schemas 投影与 dispatch 双执法 */
}

export type AgentStatus = "idle" | "running";

export interface Agent {
  readonly session: Session;
  readonly options: AgentOptions;
  readonly status: AgentStatus;
  /** insert next-turn + 唤醒；images = user 域图像块（与文本同 entry 同轮消费） */
  followup(text: string, options?: { images?: readonly ImageBlock[] }): void;
  /** insert next-step + 唤醒；images 语义同 followup */
  steer(text: string, options?: { images?: readonly ImageBlock[] }): void;
  /** 内部消息注入（docs/AGENT-MESSAGE.md §5 迁移地图）：next-step 排队 + 唤醒，领取时
   *  材料化为 agent/message{source, kind}（UI 类型隐藏、摘要按 kind 分流） */
  notify(source: string, kind: import("@x-harness/session").AgentMessageKind, text: string): void;
  /** 缺省 append clear 事件后 abort；置 per-kick sticky 取消；cause 空串护栏 */
  cancel(cause: string, options?: { keepInbox?: boolean }): void;
  /** 收敛循环（do/while 重查，跟替换驱动） */
  whenIdle(): Promise<void>;
}

export interface AgentHandle {
  readonly agent: Agent;
  dispose(): Promise<void>;
}

export interface CreateAgentOptions {
  readonly session?: CreateSessionOptions;
  readonly agent?: AgentOptions;
}

export interface ResumeAgentOptions {
  readonly id: SessionId;
  readonly agent?: AgentOptions;
}

export interface AgentLoopService {
  create(options?: CreateAgentOptions): Promise<Result<AgentHandle>>;
  /** 无 sessionArchive → 失败；修复 closers 并入 seed；不自动 kick */
  resume(options: ResumeAgentOptions): Promise<Result<AgentHandle>>;
  /** 按 id 取活 agent（dispose 后摘除）——delegation/宿主寻址 */
  get(id: SessionId): AgentHandle | undefined;
}
