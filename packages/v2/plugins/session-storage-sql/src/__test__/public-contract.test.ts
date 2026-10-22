import { describe, expect, it } from "vitest";
import { value } from "./value";
import { fixtures } from "./fixtures";
import { verifySessionStorage } from "../../../session/src/testing";

const setup = fixtures();

for (const kind of ["sqlite", "postgres"] as const)
  describe(`${kind} public storage conformance`, () => {
    it("passes the reusable contract with independent connections", async () => {
      const fixture = await setup(kind);
      const second = await fixture.independent();
      const result = await verifySessionStorage({
        first: fixture.service,
        second,
        namespace: crypto.randomUUID(),
      });
      expect(result.checks).toContain("concurrent CAS");
      expect(result.checks).toContain("atomic fork");
      expect(result.checks).toContain("concurrent identical commit");
      expect(result.checks).toHaveLength(25);
    });
    it("the public contract detects a backend that acknowledges a commit without persisting it", async () => {
      const fixture = await setup(kind);
      const broken = {
        ...fixture.service,
        async commit(input: Parameters<typeof fixture.service.commit>[0]) {
          return input.records.length
            ? {
                ok: true as const,
                value: { commitId: "batch", firstSeq: 1, lastSeq: 2, revision: 2 },
              }
            : fixture.service.commit(input);
        },
      };
      await expect(
        verifySessionStorage({
          first: broken,
          second: fixture.service,
          namespace: crypto.randomUUID(),
        }),
      ).rejects.toThrow("atomic records head projection");
    });
    it("stale storage commits report revision conflict without writing", async () => {
      const fixture = await setup(kind);
      const input = {
        namespace: fixture.namespace,
        id: "one",
        expectedRevision: 0,
        commitId: "first",
        fingerprint: "a".repeat(64),
        records: [{ seq: 1, time: 0, json: "opaque", bytes: 6 }],
        nodes: [],
      };
      value(await fixture.service.commit(input));
      expect(await fixture.service.commit({ ...input, commitId: "different" })).toMatchObject({
        ok: false,
        error: { code: "revision-conflict" },
      });
      expect(
        value(await fixture.service.read({ namespace: fixture.namespace, id: "one" })).head
          .revision,
      ).toBe(1);
    });
    it("storage commit identity rejects changed content before checking an old revision", async () => {
      const fixture = await setup(kind);
      const input = {
        namespace: fixture.namespace,
        id: "one",
        expectedRevision: 0,
        commitId: "first",
        fingerprint: "a".repeat(64),
        records: [{ seq: 1, time: 0, json: "opaque", bytes: 6 }],
        nodes: [],
      };
      const receipt = value(await fixture.service.commit(input));
      expect(value(await fixture.service.commit(input))).toEqual(receipt);
      expect(await fixture.service.commit({ ...input, fingerprint: "b".repeat(64) })).toMatchObject(
        { ok: false, error: { code: "commit-conflict" } },
      );
    });
  });
