import { expect, it } from "vitest";
import { readStorageRequest } from "../../storage";
import { readStoragePolicy } from "../../storage";
import { defaultSessionLimits } from "../../storage";
import type { SessionStorage } from "../../storage";

const key = { namespace: "default", id: "one" }; const fingerprint = "a".repeat(64);
const record = { seq: 1, time: 0, json: "a", bytes: 1 }; const commit = { ...key, expectedRevision: 0, commitId: "once", fingerprint, records: [record], nodes: [{ position: 1, seq: 1 }] };
it("storage requests reject malformed shapes and never invoke nested accessors", () => {
  let reads = 0; const hostile = Object.defineProperty({}, "seq", { get() { reads++; return 1; } }); const sparse: unknown[] = []; sparse.length = 2;
  const array = Object.defineProperty([], "0", { get() { reads++; return record; } });
  const cases: [keyof SessionStorage, unknown][] = [["read", null], ["read", {}], ["read", { ...key, extra: 1 }], ["read", { ...key, namespace: "../bad" }], ["read", { ...key, projection: 1 }], ["read", { ...key, commitId: "" }], ["create", { ...key, origin: "bad", metadata: "null" }], ["create", { ...key, origin: fingerprint, metadata: 1 }], ["getCommit", key], ["initialize", { namespace: "default", policy: {} }], ["history", { ...key, after: -1, limit: 1, maxPageBytes: 4194304 }], ["history", { ...key, after: 0, throughRevision: -1, limit: 1, maxPageBytes: 4194304 }], ["history", { ...key, after: 0, limit: 0, maxPageBytes: 4194304 }], ["history", { ...key, after: 0, limit: 4001, maxPageBytes: 4194304 }], ["history", { ...key, after: 0, limit: 1, maxPageBytes: 1023 }], ["conversation", { ...key, position: -1, limit: 1, maxPageBytes: 4194304 }], ["conversation", { ...key, position: 0, revision: -1, limit: 1, maxPageBytes: 4194304 }], ["fork", { ...key, origin: fingerprint, metadata: "null", sourceId: "one", throughRevision: 0, bytes: 0, nodes: [] }], ["fork", { ...key, origin: fingerprint, metadata: "null", sourceId: "other", throughRevision: 0, bytes: -1, nodes: [] }], ["fork", { ...key, origin: fingerprint, metadata: "null", sourceId: "other", throughRevision: 0, bytes: 0, nodes: [hostile] }]];
  for (const override of [{ expectedRevision: -1 }, { fingerprint: "x" }, { records: [] }, { records: null }, { records: sparse }, { records: array }, { records: [hostile] }, { records: [{ ...record, seq: 2 }] }, { records: [{ ...record, time: -1 }] }, { records: [{ ...record, bytes: 2 }] }, { records: [{ ...record, json: "" }] }, { records: [{ ...record, json: "x".repeat(4194305) }] }, { nodes: null }, { nodes: [hostile] }, { nodes: [{ position: 1, seq: 2 }] }, { nodes: [{ position: 0, seq: 1 }] }, { nodes: [{ position: 1, seq: 1 }, { position: 1, seq: 1 }] }, { nodes: [{ position: 2, seq: 1 }] }]) cases.push(["commit", { ...commit, ...override }]);
  for (const [method, raw] of cases) expect(readStorageRequest(method, raw), JSON.stringify([method, raw === null])).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  expect(reads).toBe(0);
});
it("persisted policies reject invalid numeric budgets while preserving fourfold configurations", () => {
  const { maxRecordBytes, maxSessionBytes, maxRecords, maxConversationNodes, maxMetadataBytes, maxSessions } = defaultSessionLimits; const policy = { maxRecordBytes, maxSessionBytes, maxRecords, maxConversationNodes, maxMetadataBytes, maxSessions };
  for (const raw of [null, {}, { ...policy, maxSessions: 0 }, { ...policy, maxRecords: 1 }, { ...policy, maxSessionBytes: 1 }, { ...policy, maxRecordBytes: 4194305 }, { ...policy, extra: 1 }]) expect(readStoragePolicy(raw).ok).toBe(false);
  expect(readStoragePolicy(Object.fromEntries(Object.entries(policy).map(([k, n]) => [k, n * 4]))).ok).toBe(true);
  expect(readStorageRequest("commit", commit).ok).toBe(true);
});
it("storage bounds cumulative bytes before accepting a maximum-sized batch", () => {
  const body = "x".repeat(4194304); const records = Array.from({ length: 5 }, (_, index) => ({ seq: index + 1, time: 0, json: body, bytes: body.length }));
  expect(readStorageRequest("commit", { ...commit, records, nodes: [] })).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } });
});
