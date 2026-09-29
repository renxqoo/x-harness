import type { Result } from "@x-harness/core";

export type SessionId = string & { readonly __brand: "SessionId" };

export interface SessionHeader {
  readonly id: SessionId;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: SessionId;
  readonly agentId?: string;
  readonly agentType?: string;
  readonly agentDepth?: number;
  readonly agentWork?: string;
  readonly agentWorktree?: string;
}

export interface ThinkingSignatureBlock {
  readonly signature: string;
  readonly redacted: boolean;
  readonly origin: { readonly provider: string; readonly model: string };
}

export type TurnEndReason =
  | { readonly kind: "completed" }
  | { readonly kind: "aborted"; readonly cause?: string }
  | { readonly kind: "blocked"; readonly reason?: string }
  | { readonly kind: "error"; readonly message: string; readonly code?: string }
  | { readonly kind: "max-tokens" }
  | { readonly kind: "interrupted" };

export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly callId: string; readonly name: string; readonly input: string }
  | { readonly type: "image"; readonly data: string; readonly mediaType: string };

export type ImageBlock = Extract<ContentBlock, { readonly type: "image" }>;

export interface ToolRef {
  readonly name: string;
  readonly description?: string;
}

export interface SessionEventData {
  readonly "turn/start": { readonly turn: number };
  readonly "turn/end": { readonly turn: number; readonly reason: TurnEndReason };
  readonly "step/start": { readonly turn: number; readonly step: number };
  readonly "step/end": { readonly turn: number; readonly step: number };
  readonly "system/message": { readonly turn: number; readonly step: number; readonly text: string };
  readonly "user/message": { readonly turn: number; readonly step: number; readonly content: readonly ContentBlock[] };
  readonly "assistant/message": {
    readonly turn: number;
    readonly step: number;
    readonly content: readonly ContentBlock[];
    readonly thinking?: string;
    readonly thinkingBlocks?: readonly ThinkingSignatureBlock[];
    readonly usage?: unknown;
    readonly stopReason?: string;
    readonly interrupted?: true;
  };
  readonly "assistant/attempt": {
    readonly turn: number;
    readonly step: number;
    readonly error: string;
    readonly content?: readonly ContentBlock[];
    readonly thinking?: string;
    readonly thinkingBlocks?: readonly ThinkingSignatureBlock[];
    readonly usage?: unknown;
  };
  readonly "tool/call": { readonly turn: number; readonly step: number; readonly callId: string; readonly name: string; readonly arguments: string };
  readonly "tool/result": { readonly turn: number; readonly step: number; readonly callId: string; readonly content: string; readonly isError?: true; readonly synthetic?: true };
  readonly "request/header": {
    readonly model: string;
    readonly provider?: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly thinking?: string;
    readonly tools: readonly ToolRef[];
  };
  readonly "request/context": { readonly provider: string; readonly model: string; readonly contextWindow?: number };
  readonly "llm/retry": {
    readonly turn: number;
    readonly step: number;
    readonly provider: string;
    readonly retry: number;
    readonly delayMs: number;
    readonly failure: { readonly message: string; readonly code?: string };
  };
  readonly "session/end-seed": { readonly inherited?: true };
  readonly "agent/inbox/spliced": InboxSpliceData;
  readonly "autocompact/checkpoint": {
    readonly turn: number;
    readonly step: number;
    readonly ledger: string;
    readonly coveredSeq: number;
    readonly stale?: true;
  };
  readonly "todo/snapshot": TodoSnapshotEventData;
  readonly "session/meta": { readonly key: string; readonly value: unknown };
  readonly "command/run": { readonly commandId: string; readonly name: string; readonly args?: string };
  readonly "command/done": { readonly commandId: string; readonly kind: "success" | "error"; readonly text?: string };
  readonly "agent/message": {
    readonly turn: number;
    readonly step: number;
    readonly source: string;
    readonly kind: AgentMessageKind;
    readonly content: readonly ContentBlock[];
  };
}

export interface TodoSnapshotTaskData {
  readonly id: string;
  readonly subject: string;
  readonly status: "pending" | "in_progress" | "completed";
  readonly description?: string;
  readonly activeForm?: string;
  readonly owner?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TodoSnapshotEventData {
  readonly seq: number;
  readonly tasks: readonly TodoSnapshotTaskData[];
  readonly edges: readonly (readonly [blocker: string, blocked: string])[];
}

export type InboxTarget = "next-turn" | "next-step";

export type AgentMessageKind = "directive" | "content";

export interface InboxEntry {
  readonly id: string;
  readonly content: readonly ContentBlock[];
  readonly origin?: { readonly source: string; readonly kind: AgentMessageKind };
}

export type InboxSpliceData =
  | { readonly op: "insert"; readonly target: InboxTarget; readonly entries: readonly InboxEntry[] }
  | { readonly op: "claim"; readonly target: InboxTarget; readonly turn: number; readonly claimed: readonly string[] }
  | { readonly op: "clear"; readonly reason: string }
  | { readonly op: "drop"; readonly target: InboxTarget; readonly dropped: readonly string[]; readonly reason: string }
  | { readonly op: "retarget"; readonly id: string; readonly to: InboxTarget };

export type SessionEventType = keyof SessionEventData;
export type SurfaceEventType = "system/message" | "user/message" | "assistant/message" | "tool/result" | "agent/message";
export type LogOnlyEventType = Exclude<SessionEventType, SurfaceEventType>;

export type SurfaceOp = "append" | { readonly op: "replace"; readonly startSeq: number; readonly endSeq: number };

export interface SurfaceIntent {
  readonly surfaceOp: SurfaceOp;
}

export type SessionEvent<K extends SessionEventType = SessionEventType> = {
  [L in K]: {
    readonly type: L;
    readonly seq: number;
    readonly time: number;
    readonly data: SessionEventData[L];
  } & (L extends SurfaceEventType ? { readonly surfaceOp: SurfaceOp } : { readonly surfaceOp?: never });
}[K];

export interface SurfaceNode<K extends SurfaceEventType = SurfaceEventType> {
  readonly seq: number;
  readonly event: SessionEvent<K>;
}

export type SurfaceMessage =
  | { readonly role: "system"; readonly text: string }
  | { readonly role: "user"; readonly content: readonly ContentBlock[] }
  | { readonly role: "assistant"; readonly content: readonly ContentBlock[]; readonly usage?: unknown; readonly stopReason?: string; readonly thinkingBlocks?: readonly ThinkingSignatureBlock[] }
  | { readonly role: "tool"; readonly callId: string; readonly content: string; readonly isError?: true };

export interface Session {
  readonly id: SessionId;
  readonly header: SessionHeader;
  append<K extends SurfaceEventType>(type: K, data: SessionEventData[K], intent: SurfaceIntent): Result<SessionEvent<K>>;
  append<K extends LogOnlyEventType>(type: K, data: SessionEventData[K]): Result<SessionEvent<K>>;
  events(): readonly SessionEvent[];
  surface(): readonly SurfaceNode[];
  deriveMessages(): readonly SurfaceMessage[];
}

export interface CreateSessionOptions {
  readonly id?: SessionId;
  readonly seed?: readonly SessionEvent[];
  readonly parent?: SessionId;
  readonly agent?: { readonly id: string; readonly type: string; readonly depth: number; readonly work?: string; readonly worktree?: string };
  readonly header?: SessionHeader;
}

export interface ForkSessionOptions {
  readonly untilSeq?: number;
  readonly id?: SessionId;
}

export interface SessionStore {
  create(options?: CreateSessionOptions): Promise<Result<Session>>;
  fork(source: SessionId, options?: ForkSessionOptions): Promise<Result<Session>>;
  get(id: SessionId): Session | undefined;
  list(): readonly SessionId[];
  flush(id: SessionId): Promise<Result<true>>;
  dispose(id: SessionId): Result<true>;
}

export interface SessionSnapshot {
  readonly header: SessionHeader;
  readonly events: readonly SessionEvent[];
}

export interface SessionArchive {
  list(): readonly SessionId[];
  read(id: SessionId): Promise<Result<SessionSnapshot>>;
  listHeaders(): Promise<readonly SessionHeader[]>;
}
