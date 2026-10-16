import { expect, it } from "vitest";
import { verifySessionStorage } from "../../../session/src/testing";
import { fixtures, value, policy, key, hash, commit } from "./helpers";

const fixture = fixtures();
it("two independent JSONL clients implement the complete public storage contract", async () => {
  const f = await fixture(); const second = await f.open();
  const report = await verifySessionStorage({ first: f.storage, second: second.storage, namespace: "conformance" }); expect(report.checks).toHaveLength(20);
});
it("reopening preserves immutable history, receipts and replacement positions", async () => {
  const f = await fixture(); value(await f.storage.initialize({ namespace: key.namespace, policy })); value(await f.storage.create({ ...key, origin: hash, metadata: "null" }));
  value(await f.storage.commit(commit())); value(await f.storage.commit(commit(1, "second", [{ position: 1, seq: 2 }]))); value(await f.host.close());
  const reopened = await f.open(); expect(value(await reopened.storage.read({ ...key, projection: true })).nodes).toEqual([{ position: 1, seq: 2 }]);
  expect(value(await reopened.storage.history({ ...key, after: 0, limit: 100, maxPageBytes: 4194304 })).records.map((r) => r.seq)).toEqual([1, 2]); expect(value(await reopened.storage.getCommit({ ...key, commitId: "c0" })).receipt.revision).toBe(1);
});
