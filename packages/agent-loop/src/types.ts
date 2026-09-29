import type { Result } from "@x-harness/core";
import type { ImageBlock, Session, SessionId, CreateSessionOptions } from "@x-harness/session";
import type { ThinkingLevel } from "@x-harness/llm";

export interface AgentOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly thinking?: ThinkingLevel;
  readonly systemPrompt?: string;
  readonly maxParallelToolCalls?: number;
  readonly maxToolResultChars?: number;
  readonly streamIdleTimeoutMs?: number;
}

export type AgentStatus = "idle" | "running";

export type NotifyTarget = "next-step" | "next-turn";

export interface Agent {
  readonly session: Session;
  readonly options: AgentOptions;
  readonly status: AgentStatus;
  followup(text: string, options?: { images?: readonly ImageBlock[] }): void;
  steer(text: string, options?: { images?: readonly ImageBlock[] }): void;
  notify(message: { readonly source: string; readonly kind: import("@x-harness/session").AgentMessageKind; readonly text: string; readonly target?: NotifyTarget }): void;
  cancel(cause: string, options?: { keepInbox?: boolean }): void;
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
  resume(options: ResumeAgentOptions): Promise<Result<AgentHandle>>;
  get(id: SessionId): AgentHandle | undefined;
}
