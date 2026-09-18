// Agent-Loop 契约类型（docs/AGENT-LOOP-DRIVER.md §1.1）。

import type { Result } from "@x-harness/core";
import type { CreateSessionOptions, Session, SessionId } from "@x-harness/session";

export interface AgentOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** 静态系统提示词：优先于 systemPrompt.assemble() */
  readonly systemPrompt?: string;
  /** 并行工具池上限（默认 10） */
  readonly maxParallelToolCalls?: number;
  /** tool/result 落账前截断（默认 100_000，尾标 …[truncated]） */
  readonly maxToolResultChars?: number;
}

export type AgentStatus = "idle" | "running";

export interface Agent {
  readonly session: Session;
  readonly options: AgentOptions;
  readonly status: AgentStatus;
  /** insert next-turn + 唤醒 */
  followup(text: string): void;
  /** insert next-step + 唤醒 */
  steer(text: string): void;
  /** insert next-step 不唤醒 */
  inject(text: string): void;
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
}
