import type { CommitReceipt, SessionLimits, SessionResult } from "../contracts/types";

export type StoragePolicy = Pick<SessionLimits, "maxRecordBytes" | "maxSessionBytes" | "maxRecords" | "maxConversationNodes" | "maxMetadataBytes" | "maxSessions">;
export interface StorageKey { readonly namespace: string; readonly id: string }
export interface StoredHead { readonly id: string; readonly origin: string; readonly createdAt: number; readonly revision: number; readonly bytes: number; readonly metadata: string; readonly parent?: { readonly id: string; readonly revision: number } }
export interface StoredRecord { readonly seq: number; readonly time: number; readonly json: string; readonly bytes: number }
export interface StorageNode { readonly position: number; readonly seq: number }
export interface StoredCommit { readonly receipt: CommitReceipt; readonly fingerprint: string }
export interface StorageSnapshot { readonly head: StoredHead; readonly nodes?: readonly StorageNode[]; readonly commit?: StoredCommit }
export interface StorageCreate extends StorageKey { readonly origin: string; readonly metadata: string }
export interface StorageCommit extends StorageKey { readonly expectedRevision: number; readonly commitId: string; readonly fingerprint: string; readonly records: readonly StoredRecord[]; readonly nodes: readonly StorageNode[] }
export interface StorageFork extends StorageCreate { readonly sourceId: string; readonly throughRevision: number; readonly bytes: number; readonly nodes: readonly StorageNode[] }
export interface StoragePageRequest extends StorageKey { readonly limit: number; readonly maxPageBytes: number }
export interface StorageHistory extends StoragePageRequest { readonly after: number; readonly throughRevision?: number }
export interface StorageConversation extends StoragePageRequest { readonly position: number; readonly revision?: number }
export interface StorageHistoryPage { readonly revision: number; readonly records: readonly StoredRecord[]; readonly next?: number }
export interface StorageConversationPage { readonly revision: number; readonly records: readonly (StoredRecord & StorageNode)[]; readonly next?: number }
export type StoredSessionSummary = Pick<StoredHead, "id" | "createdAt" | "metadata" | "parent">;
export interface StorageList { readonly namespace: string; readonly after?: string; readonly limit: number; readonly maxPageBytes: number }
export interface StorageListPage { readonly sessions: readonly StoredSessionSummary[]; readonly next?: string }
export interface SessionStorage {
  list(input: StorageList): Promise<SessionResult<StorageListPage>>;
  initialize(input: { readonly namespace: string; readonly policy: StoragePolicy }): Promise<SessionResult<void>>;
  read(input: StorageKey & { readonly commitId?: string; readonly projection?: boolean }): Promise<SessionResult<StorageSnapshot>>;
  create(input: StorageCreate): Promise<SessionResult<StoredHead>>;
  commit(input: StorageCommit): Promise<SessionResult<CommitReceipt>>;
  history(input: StorageHistory): Promise<SessionResult<StorageHistoryPage>>;
  conversation(input: StorageConversation): Promise<SessionResult<StorageConversationPage>>;
  fork(input: StorageFork): Promise<SessionResult<StoredHead>>;
  getCommit(input: StorageKey & { readonly commitId: string }): Promise<SessionResult<StoredCommit>>;
}
