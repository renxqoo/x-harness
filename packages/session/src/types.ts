// Session 契约类型：事件信封判别联合、13 词条闭合词表、surface 投影、仓库接口（docs/SESSION.md §1）

import type { Result } from "@x-harness/core";

export type SessionId = string & { readonly __brand: "SessionId" };

/** 无格式版本字段：格式身份判别 = 闭合词表 + fail-closed 校验（docs/SESSION.md §1.6）；
 *  语义级变更（改既有词条含义/信封机制）发生的当下再引入显式判别字段，字段缺失即变更前档案 */
export interface SessionHeader {
  readonly id: SessionId;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: SessionId;
}

export type TurnEndReason =
  | { readonly kind: "completed" }
  | { readonly kind: "aborted" }
  | { readonly kind: "blocked" }
  | { readonly kind: "error"; readonly message: string; readonly code?: string }
  | { readonly kind: "max-tokens" }
  | { readonly kind: "interrupted" };

export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly callId: string; readonly name: string; readonly input: string };

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
    readonly usage?: unknown;
    readonly stopReason?: string;
    readonly interrupted?: true;
  };
  readonly "assistant/attempt": { readonly turn: number; readonly step: number; readonly error: string };
  readonly "tool/call": { readonly turn: number; readonly step: number; readonly callId: string; readonly name: string; readonly arguments: string };
  readonly "tool/result": { readonly turn: number; readonly step: number; readonly callId: string; readonly content: string; readonly isError?: true };
  readonly "request/header": {
    readonly model: string;
    readonly provider?: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly tools: readonly ToolRef[];
  };
  readonly "request/context": { readonly provider: string; readonly model: string; readonly contextWindow?: number };
  readonly "session/end-seed": { readonly inherited?: true };
  /** 收件箱拼接：fold 投影归 agent-loop（docs/SESSION-RESUME.md §1.1——claim 按成员移除、判重按当前在场） */
  readonly "agent/inbox/spliced": InboxSpliceData;
}

export type InboxTarget = "next-turn" | "next-step";

export interface InboxEntry {
  readonly id: string;
  readonly content: readonly ContentBlock[];
}

export type InboxSpliceData =
  | { readonly op: "insert"; readonly target: InboxTarget; readonly entries: readonly InboxEntry[] }
  | { readonly op: "claim"; readonly target: InboxTarget; readonly turn: number; readonly claimed: readonly string[] }
  | { readonly op: "clear"; readonly reason: string };

export type SessionEventType = keyof SessionEventData;
/** 产模型可见消息的词条：仅此 4 类可携带 surfaceOp */
export type SurfaceEventType = "system/message" | "user/message" | "assistant/message" | "tool/result";
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
  | { readonly role: "assistant"; readonly content: readonly ContentBlock[]; readonly usage?: unknown; readonly stopReason?: string }
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
  /** resume/replay 的历史前缀：校验通过后由构造器追加 end-seed（不带 inherited） */
  readonly seed?: readonly SessionEvent[];
  /** 血缘回填：resume 消费方从 archive.read 的 header.parentSession 取（fork 内部自动携带） */
  readonly parent?: SessionId;
  /** resume 的归档 header 原文：提供时以它为准（id 取 header.id、parent 忽略、归档元数据保留） */
  readonly header?: SessionHeader;
}

export interface ForkSessionOptions {
  /** 前缀切口（闭区间右端）；值域 0 ≤ untilSeq < 源日志长度，空前缀非法 */
  readonly untilSeq?: number;
  readonly id?: SessionId;
}

export interface SessionStore {
  create(options?: CreateSessionOptions): Promise<Result<Session>>;
  fork(source: SessionId, options?: ForkSessionOptions): Promise<Result<Session>>;
  get(id: SessionId): Session | undefined;
  list(): readonly SessionId[];
  /** 落盘屏障：空屏障语义——未装配持久化插件时成功不承诺字节落盘（docs/SESSION.md §1.5） */
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
}
