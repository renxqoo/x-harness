import type { SessionResult } from "../../session/src/contracts";
import type { StoragePolicy } from "../../session/src/storage";

export type Parameters = readonly (string | number | null)[];
export type Row = Record<string, unknown>;
export interface Query { all(text: string, values?: Parameters): Promise<readonly Row[]>; lock(key: string): Promise<void> }
export interface Database { transaction<T>(write: boolean, run: (query: Query) => Promise<T>): Promise<T>; close(): Promise<void> }
export interface StorageLimits { readonly maxQueue: number; readonly maxConcurrent: number; readonly lockTimeoutMs: number; readonly transactionTimeoutMs: number }
export interface NamespaceOptions { readonly namespace: string; readonly limits: StoragePolicy }
export interface Store {
  run<T>(input: { write: boolean; signal?: AbortSignal }, action: (query: Query) => Promise<SessionResult<T>>): Promise<SessionResult<T>>;
  close(): Promise<SessionResult<void>>;
}
