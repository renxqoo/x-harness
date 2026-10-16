import type { JsonValue, Result } from "../../../../core/src/index";

export type SessionErrorCode = "invalid-input" | "not-found" | "already-exists" | "revision-conflict" | "commit-conflict" | "invalid-replacement" | "capacity-exceeded" | "record-too-large" | "busy" | "closed" | "cancelled" | "storage-unavailable" | "storage-corrupt" | "configuration-conflict";
export interface SessionError { readonly source: "session"; readonly code: SessionErrorCode }
export type SessionResult<T> = Result<T, SessionError>;
export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mediaType: string; readonly source: string }
  | { readonly type: "tool-call"; readonly callId: string; readonly name: string; readonly input: JsonValue }
  | { readonly type: "reasoning"; readonly text: string; readonly signature?: string; readonly origin?: { readonly provider: string; readonly model: string }; readonly redacted?: boolean };
export interface SessionMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: readonly ContentBlock[];
  readonly callId?: string;
  readonly isError?: boolean;
  readonly metadata?: JsonValue;
}
export type SessionEntry =
  | { readonly kind: "event"; readonly type: string; readonly data: JsonValue }
  | { readonly kind: "message"; readonly message: SessionMessage; readonly replace?: { readonly startSeq: number; readonly endSeq: number } };
export interface SessionRecord { readonly seq: number; readonly time: number; readonly entry: SessionEntry }
export interface ConversationNode { readonly position: number; readonly seq: number; readonly time: number; readonly message: SessionMessage }
export interface SessionInfo {
  readonly id: string;
  readonly createdAt: number;
  readonly revision: number;
  readonly bytes: number;
  readonly metadata: JsonValue;
  readonly parent?: { readonly id: string; readonly revision: number };
}
export interface CreateSession { readonly id: string; readonly metadata?: JsonValue }
export interface AppendSession { readonly id: string; readonly expectedRevision: number; readonly commitId: string; readonly entries: readonly SessionEntry[] }
export interface ForkSession extends CreateSession { readonly sourceId: string; readonly throughRevision: number }
export interface CommitReceipt { readonly commitId: string; readonly firstSeq: number; readonly lastSeq: number; readonly revision: number }
export interface HistoryRequest { readonly id: string; readonly after?: number; readonly throughRevision?: number; readonly limit?: number }
export interface ConversationRequest { readonly id: string; readonly after?: string; readonly revision?: number; readonly limit?: number }
export interface HistoryPage { readonly revision: number; readonly records: readonly SessionRecord[]; readonly next?: number }
export interface ConversationPage { readonly revision: number; readonly nodes: readonly ConversationNode[]; readonly next?: string }
export type SessionSummary = Pick<SessionInfo, "id" | "createdAt" | "metadata" | "parent">;
export interface ListSessions { readonly after?: string; readonly limit?: number }
export interface SessionListPage { readonly sessions: readonly SessionSummary[]; readonly next?: string }
export interface SessionService {
  list(input: ListSessions): Promise<SessionResult<SessionListPage>>;
  create(input: CreateSession): Promise<SessionResult<SessionInfo>>;
  get(input: { readonly id: string }): Promise<SessionResult<SessionInfo>>;
  append(input: AppendSession): Promise<SessionResult<CommitReceipt>>;
  history(input: HistoryRequest): Promise<SessionResult<HistoryPage>>;
  conversation(input: ConversationRequest): Promise<SessionResult<ConversationPage>>;
  fork(input: ForkSession): Promise<SessionResult<SessionInfo>>;
  getCommit(input: { readonly id: string; readonly commitId: string }): Promise<SessionResult<CommitReceipt>>;
}
export interface SessionLimits {
  readonly maxRecordBytes: number;
  readonly maxBatchBytes: number;
  readonly maxBatchEntries: number;
  readonly maxSessionBytes: number;
  readonly maxRecords: number;
  readonly maxConversationNodes: number;
  readonly maxMetadataBytes: number;
  readonly maxSessions: number;
  readonly maxPageBytes: number;
  readonly pageSize: number;
  readonly maxPageSize: number;
}
export interface SessionOptions { readonly namespace?: string; readonly limits?: Partial<SessionLimits> }
