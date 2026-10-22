import type { FileHandle } from "node:fs/promises";
import type {
  StoragePolicy,
  StoredHead,
  StorageNode,
  StoredCommit,
} from "../../session/src/storage";
import type { SessionResult } from "../../session/src/contracts";
import type { createFileIO } from "./create-file-io";
export interface JsonlLimits {
  readonly maxQueue: number;
  readonly lockTimeoutMs: number;
  readonly operationTimeoutMs: number;
}
export type FileIO = ReturnType<typeof createFileIO>;
export interface RecordIndex {
  offset: number;
  readonly length: number;
  readonly bytes: number;
  readonly time: number;
  readonly digest: string;
}
export interface Journal {
  head: StoredHead;
  records: RecordIndex[];
  nodes: readonly StorageNode[];
  commits: Map<string, StoredCommit>;
  digest: string;
  end: number;
  recordBytes: number;
  identity: string;
  size: number;
  modified: bigint;
  compactBytes?: number;
}
export interface Operation {
  readonly io: FileIO;
  readonly root: string;
  check(this: void): void;
  durable: boolean;
}
export interface SessionFile {
  readonly handle: FileHandle;
  readonly journal: Journal;
  readonly path: string;
  readonly policy: StoragePolicy;
}
export interface JsonlStore {
  run<T>(
    signal: AbortSignal | undefined,
    action: (operation: Operation) => Promise<SessionResult<T>>,
  ): Promise<SessionResult<T>>;
  load(
    operation: Operation,
    key: { namespace: string; id: string; compact?: boolean },
    policy: StoragePolicy,
  ): Promise<SessionFile>;
  invalidate(): void;
  close(): Promise<SessionResult<void>>;
}
