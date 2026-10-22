import { expect, it } from "vitest";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listFixtures } from "./list-fixtures";
import { value } from "./helpers";
const fixture = listFixtures();
const folder = dirname(fileURLToPath(import.meta.url));

for (const kind of ["sqlite", "postgres", "jsonl"] as const)
  for (const built of [false, true])
    it(`${kind} ${built ? "built" : "source"} process discovers persisted ids without receiving them`, async () => {
      const f = await fixture(kind);
      const id = crypto.randomUUID();
      const branch = `branch-${id}`;
      value(await f.service.create({ id, metadata: { owner: "catalog" } }));
      value(await f.service.fork({ id: branch, sourceId: id, throughRevision: 0 }));
      value(await f.host.close());
      const storage =
        kind === "jsonl"
          ? { kind, path: join(f.directory, "store") }
          : (f.options as import("./helpers").FixtureOptions).storage;
      const form = built ? "dist/index.js" : "src/index.ts";
      const process = Bun.spawn(
        [
          Bun.which("bun")!,
          resolve(folder, "catalog-process.ts"),
          resolve(folder, `../../${form}`),
          resolve(folder, `../../../session-${kind}/${form}`),
          JSON.stringify({ session: { namespace: f.options.namespace }, storage }),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const timer = setTimeout(() => process.kill("SIGKILL"), 10000);

      try {
        const [code, out, err] = await Promise.all([
          process.exited,
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
        ]);
        expect(code, err).toBe(0);
        const result = JSON.parse(out) as {
          sessions: { id: string; metadata: unknown; parent?: unknown }[];
          next?: string;
        };
        expect(result.sessions.map((summary) => summary.id)).toEqual([id, branch].sort());
        expect(result.sessions.find((summary) => summary.id === branch)?.parent).toEqual({
          id,
          revision: 0,
        });
        expect(
          result.sessions.every(
            (summary) => JSON.stringify(summary.metadata) === JSON.stringify({ owner: "catalog" }),
          ),
        ).toBe(true);
        expect(result.next).toBeUndefined();
      } finally {
        clearTimeout(timer);

        if (process.exitCode === null) process.kill("SIGKILL");

        await process.exited;
      }
    }, 15000);
