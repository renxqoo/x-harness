import { readFile, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { expect, it, inject } from "vitest";
import { createHost } from "../../../../core/src/index";
import { session } from "../index";
import { value, makePlugins, message } from "./helpers";

for (const kind of ["sqlite", "postgres"] as const)
  it(`${kind} reopens an actual previously committed database without rewriting its format`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-existing-"));
    const path = join(directory, "data.sqlite");
    const namespace = kind === "sqlite" ? "baseline-open" : crypto.randomUUID();
    const host = value(createHost());

    try {
      if (kind === "sqlite")
        await copyFile(new URL("./fixtures/committed.sqlite", import.meta.url), path);
      else {
        const preparation = value(createHost());

        try {
          value(
            await preparation.install(
              makePlugins({
                namespace: crypto.randomUUID(),
                storage: { kind, url: inject("sessionPostgresUrl") },
              }),
            ),
          );
        } finally {
          value(await preparation.close());
        }

        const rows = JSON.parse(
          await readFile(new URL("./fixtures/committed.json", import.meta.url), "utf8"),
        ) as Record<string, Record<string, string | number | null>[]>;
        const db = new SQL(inject("sessionPostgresUrl"));

        try {
          await db.begin(async (tx) => {
            for (const [table, entries] of Object.entries(rows))
              for (const row of entries) {
                const keys = Object.keys(row);
                await tx.unsafe(
                  `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) ON CONFLICT DO NOTHING`,
                  Object.values(row).map((value, i) =>
                    keys[i] === "namespace" ? namespace : value,
                  ),
                );
              }
          });
        } finally {
          await db.close();
        }
      }

      value(
        await host.install(
          makePlugins({
            namespace,
            storage:
              kind === "sqlite" ? { kind, path } : { kind, url: inject("sessionPostgresUrl") },
          }),
        ),
      );
      const service = value(host.use(session));
      expect(value(await service.get({ id: "existing" }))).toMatchObject({
        revision: 3,
        metadata: { title: "kept" },
      });
      expect(value(await service.history({ id: "existing" })).records.map((r) => r.seq)).toEqual([
        1, 2, 3,
      ]);
      expect(value(await service.conversation({ id: "existing" })).nodes.map((n) => n.seq)).toEqual(
        [3],
      );
      expect(value(await service.getCommit({ id: "existing", commitId: "before" }))).toMatchObject({
        firstSeq: 1,
        lastSeq: 3,
        revision: 3,
      });
      value(
        await service.append({
          id: "existing",
          expectedRevision: 3,
          commitId: "after",
          entries: [message("continues")],
        }),
      );
      expect(value(await service.get({ id: "existing" })).revision).toBe(4);
    } finally {
      value(await host.close());
      await rm(directory, { recursive: true, force: true });
    }
  });
