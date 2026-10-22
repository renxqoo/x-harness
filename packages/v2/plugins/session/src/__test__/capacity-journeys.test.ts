import { expect, it } from "vitest";
import { fixtures, value, event } from "./helpers";

const setup = fixtures();

for (const kind of ["sqlite", "postgres"] as const) {
  it(`${kind} byte quotas reject a new batch while preserving previously committed records`, async () => {
    const { service } = await setup(kind, {
      maxRecordBytes: 1024,
      maxBatchBytes: 4096,
      maxPageBytes: 8192,
      maxSessionBytes: 4096,
    });
    value(await service.create({ id: "one" }));
    value(
      await service.append({
        id: "one",
        expectedRevision: 0,
        commitId: "first",
        entries: Array.from({ length: 4 }, () => event("x".repeat(900))),
      }),
    );
    expect(
      await service.append({
        id: "one",
        expectedRevision: 4,
        commitId: "overflow",
        entries: [event("x".repeat(900))],
      }),
    ).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } });
    expect(value(await service.get({ id: "one" })).revision).toBe(4);
    expect(value(await service.history({ id: "one" })).records).toHaveLength(4);
  });
  it(`${kind} byte-limited pages always advance without omitting records`, async () => {
    const { service } = await setup(kind, {
      maxRecordBytes: 1024,
      maxBatchBytes: 4096,
      maxPageBytes: 5120,
    });
    value(await service.create({ id: "one" }));

    for (let batch = 0; batch < 3; batch++)
      value(
        await service.append({
          id: "one",
          expectedRevision: batch * 4,
          commitId: `batch-${batch}`,
          entries: Array.from({ length: 4 }, () => event("x".repeat(900))),
        }),
      );

    let after = 0;
    const seqs: number[] = [];

    for (let page = 0; page < 12; page++) {
      const result = value(
        await service.history({ id: "one", after, throughRevision: 12, limit: 100 }),
      );
      expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(5120);
      expect(result.records.length).toBeGreaterThan(0);
      seqs.push(...result.records.map((record) => record.seq));

      if (result.next === undefined) break;

      expect(result.next).toBeGreaterThan(after);
      after = result.next;
    }

    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });
  it(`${kind} sixteen thousand records can be paged and forked without a whole-history cache`, async () => {
    const { service } = await setup(kind);
    value(await service.create({ id: "one" }));

    for (let batch = 0; batch < 128; batch++)
      value(
        await service.append({
          id: "one",
          expectedRevision: batch * 128,
          commitId: `batch-${batch}`,
          entries: Array.from({ length: 128 }, (_, index) => event({ index: batch * 128 + index })),
        }),
      );

    let after = 0;
    let count = 0;

    do {
      const page = value(
        await service.history({ id: "one", after, throughRevision: 16384, limit: 1000 }),
      );

      for (const record of page.records) {
        count++;
        expect(record.seq).toBe(count);
      }

      after = page.next ?? 0;
    } while (after);

    expect(count).toBe(16384);
    expect(
      value(await service.fork({ id: "child", sourceId: "one", throughRevision: 16384 })).revision,
    ).toBe(16384);
    expect(value(await service.conversation({ id: "child" })).nodes).toEqual([]);
  }, 30000);
  it(`${kind} legal limits above defaults allow more than ten thousand projection nodes and thousand-record pages`, async () => {
    const { service } = await setup(kind, {
      maxConversationNodes: 12000,
      maxPageSize: 4000,
      pageSize: 400,
    });
    value(await service.create({ id: "large-view" }));
    let revision = 0;

    while (revision < 10001) {
      const count = Math.min(128, 10001 - revision);
      value(
        await service.append({
          id: "large-view",
          expectedRevision: revision,
          commitId: `batch-${revision}`,
          entries: Array.from({ length: count }, () => ({
            kind: "message" as const,
            message: { role: "user" as const, content: [{ type: "text" as const, text: "x" }] },
          })),
        }),
      );
      revision += count;
    }

    const page = value(await service.conversation({ id: "large-view", limit: 2000 }));
    expect(page.nodes).toHaveLength(2000);
    expect(page.next).toBeDefined();
    expect(page.revision).toBe(10001);
    expect(value(await service.history({ id: "large-view", limit: 2000 })).records).toHaveLength(
      2000,
    );
  }, 30000);
}
