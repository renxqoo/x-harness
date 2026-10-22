import type { SessionLimits } from "./types";
export const defaultSessionLimits: SessionLimits = Object.freeze({
  maxRecordBytes: 1048576,
  maxBatchBytes: 4194304,
  maxBatchEntries: 128,
  maxSessionBytes: 536870912,
  maxRecords: 100000,
  maxConversationNodes: 10000,
  maxMetadataBytes: 16384,
  maxSessions: 10000,
  maxPageBytes: 4194304,
  pageSize: 100,
  maxPageSize: 1000,
});
