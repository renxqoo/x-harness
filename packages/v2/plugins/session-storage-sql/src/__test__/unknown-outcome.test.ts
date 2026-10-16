import { expect, it } from "vitest";
import { fixtures } from "./fixtures";
import { value } from "./value";
import type { Store } from "../types";

const setup = fixtures();
for (const kind of ["sqlite", "postgres"] as const) it(`${kind} an absent receipt does not prove an in-flight commit will not subsequently succeed`, async () => {
  const fixture = await setup(kind); const store = fixture.store; const reader = await fixture.independent();
  let begun!: () => void; let release!: () => void; const ready = new Promise<void>((resolve) => { begun = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
  const delayed: Store = { ...store, run: (input, action) => store.run(input, async (query) => { const result = await action(query); begun(); await gate; return result; }) };
  const opened = await fixture.open(delayed); const json = '{"kind":"event","type":"test","data":null}';
  const input = { namespace: fixture.namespace, id: "one", expectedRevision: 0, commitId: "uncertain", fingerprint: "b".repeat(64), records: [{ seq: 1, time: 1, json, bytes: new TextEncoder().encode(json).length }], nodes: [] };
  const pending = opened.service.commit(input);
  try {
    await ready;
    expect(await reader.getCommit({ namespace: fixture.namespace, id: "one", commitId: "uncertain" })).toMatchObject({ ok: false, error: { code: "not-found" } });
    release(); const committed = value(await pending);
    expect(value(await fixture.service.commit(input))).toEqual(committed); expect(value(await fixture.service.getCommit({ namespace: fixture.namespace, id: "one", commitId: "uncertain" })).receipt).toEqual(committed); expect(value(await fixture.service.read({ namespace: fixture.namespace, id: "one" })).head.revision).toBe(1);
  } finally { release(); await pending; }
});
