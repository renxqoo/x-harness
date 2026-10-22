import { expect, it } from "vitest";
import { fixtures } from "./fixtures";
import { value } from "./value";
const fixture = fixtures();

for (const kind of ["sqlite", "postgres"] as const)
  it(`${kind} reusing a sequence at a different position updates the persisted projection`, async () => {
    const f = await fixture(kind);
    const key = { namespace: f.namespace, id: "one" };
    const fingerprint = "a".repeat(64);
    value(
      await f.service.commit({
        ...key,
        expectedRevision: 0,
        commitId: "first",
        fingerprint,
        records: [
          { seq: 1, time: 0, json: "a", bytes: 1 },
          { seq: 2, time: 0, json: "b", bytes: 1 },
        ],
        nodes: [{ position: 2, seq: 2 }],
      }),
    );
    value(
      await f.service.commit({
        ...key,
        expectedRevision: 2,
        commitId: "move",
        fingerprint,
        records: [{ seq: 3, time: 0, json: "c", bytes: 1 }],
        nodes: [{ position: 1, seq: 2 }],
      }),
    );
    const independent = await f.independent();
    expect(value(await independent.read({ ...key, projection: true })).nodes).toEqual([
      { position: 1, seq: 2 },
    ]);
  });
