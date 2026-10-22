import { expect, it } from "vitest";
import { readStoredHead } from "../read-stored-head";
import { readStoredRecord } from "../read-stored-record";

it("stored headers reject corrupt JSON and unsafe numeric or parent fields", () => {
  const head = { id: "one", origin: "a", createdAt: 0, revision: 0, bytes: 0, metadata: "null" };

  for (const patch of [
    { id: "../x" },
    { createdAt: -1 },
    { metadata: "x".repeat(101) },
    { metadata: "not-json" },
    { metadata: "1e999" },
    { parent: { id: "other", revision: -1 } },
  ])
    expect(readStoredHead({ ...head, ...patch }, 100)).toMatchObject({
      ok: false,
      error: { code: "storage-corrupt" },
    });
});
it("stored records reject invalid numbers canonical JSON mismatches and incorrect byte counts", () => {
  const record = { seq: 1, time: 0, json: '{"data":null,"kind":"event","type":"e"}', bytes: 39 };

  for (const patch of [
    { seq: 0 },
    { time: -1 },
    { bytes: -1 },
    { json: "x".repeat(101) },
    { json: "not-json" },
    { json: "1e999" },
    { json: '{"kind":"event","type":"e","data":null}' },
    { json: "{}", bytes: 2 },
  ])
    expect(readStoredRecord({ ...record, ...patch }, 100)).toMatchObject({
      ok: false,
      error: { code: "storage-corrupt" },
    });
});

it("the shared metadata decoder rejects invalid budgets instead of permitting an unbounded parse", async () => {
  const { readStorageMetadata } = await import("../../storage");

  for (const maximum of [0, -1, NaN, Infinity, 65537])
    expect(readStorageMetadata("null", maximum)).toMatchObject({
      ok: false,
      error: { code: "storage-corrupt" },
    });

  expect(readStorageMetadata("null")).toEqual({ ok: true, value: null });
});
