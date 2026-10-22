import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "../../../../core/src/index";
import { createSessionPlugin, session } from "../index";
import type { SessionService } from "../index";
import { createSqliteSessionPlugin } from "../../../session-sqlite/src/index";
import { createJsonlSessionPlugin } from "../../../session-jsonl/src/index";
import { value, message } from "./helpers";
import type { Host } from "../../../../core/src/index";

const CLIENTS = 8;
const OPERATIONS = 60;

for (const kind of ["sqlite", "jsonl"] as const)
  it(`${kind} concurrent clients converge on one revision history`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `session-stress-${kind}-`));
    const clients: { service: SessionService; host: Host }[] = [];

    try {
      for (let index = 0; index < CLIENTS; index++) {
        const host = value(createHost({ limits: { callTimeoutMs: 60000, closeTimeoutMs: 30000 } }));
        const storage =
          kind === "sqlite"
            ? value(createSqliteSessionPlugin({ path: join(directory, "data.sqlite") }))
            : value(
                createJsonlSessionPlugin({
                  path: join(directory, "journal"),
                  limits: { lockTimeoutMs: 4000 },
                }),
              );
        value(await host.install([storage, value(createSessionPlugin({ namespace: "stress" }))]));
        clients.push({ service: value(host.use(session)), host });
      }

      value(await clients[0]!.service.create({ id: "one" }));
      let successes = 0;
      const unexpected = new Map<string, number>();
      await Promise.all(
        clients.map(async (client, index) => {
          let expected = 0;

          for (let operation = 0; operation < OPERATIONS; operation++) {
            const result = await client.service.append({
              id: "one",
              expectedRevision: expected,
              commitId: `c${index}-${operation}`,
              entries: [message(`client-${index}-op-${operation}`)],
            });

            if (result.ok) {
              successes++;
              expected = result.value.revision;
            } else if (result.error.code === "revision-conflict" || result.error.code === "busy") {
              const head = await client.service.get({ id: "one" });

              if (head.ok) expected = head.value.revision;
            } else unexpected.set(result.error.code, (unexpected.get(result.error.code) ?? 0) + 1);
          }
        }),
      );
      const final = value(await clients[0]!.service.get({ id: "one" }));
      expect(final.revision).toBe(successes);
      expect([...unexpected.entries()]).toEqual([]);
      const history = value(await clients[0]!.service.history({ id: "one", limit: 1000 }));
      expect(history.records).toHaveLength(final.revision);
      const walk: string[] = [];
      let cursor: string | undefined;

      do {
        const page = value(
          await clients[0]!.service.conversation({
            id: "one",
            limit: 1000,
            ...(cursor ? { after: cursor } : {}),
          }),
        );
        walk.push(
          ...page.nodes.map((node) =>
            node.message.content[0]?.type === "text"
              ? (node.message.content[0] as { text: string }).text
              : "?",
          ),
        );
        cursor = page.next;
      } while (cursor);

      expect(walk).toHaveLength(final.revision);
      expect(new Set(walk).size).toBe(walk.length);
    } finally {
      for (const client of clients) {
        try {
          await client.host.close();
        } catch {}
      }

      await rm(directory, { recursive: true, force: true });
    }
  }, 120000);
