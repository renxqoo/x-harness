import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "../../../../core/src/index";
import { createSessionPlugin, session } from "../index";
import type { SessionEntry } from "../index";
import { createSqliteSessionPlugin } from "../../../session-sqlite/src/index";
import { createJsonlSessionPlugin } from "../../../session-jsonl/src/index";
import { value } from "./helpers";

type Backend = "sqlite" | "jsonl";

async function openService(kind: Backend, directory: string) {
  const host = value(createHost({ limits: { callTimeoutMs: 30000, closeTimeoutMs: 30000 } }));
  const storage =
    kind === "sqlite"
      ? value(createSqliteSessionPlugin({ path: join(directory, `${kind}.sqlite`) }))
      : value(createJsonlSessionPlugin({ path: join(directory, `${kind}-jsonl`) }));
  value(await host.install([storage, value(createSessionPlugin({ namespace: "hostile" }))]));
  return { service: value(host.use(session)), host };
}

for (const kind of ["sqlite", "jsonl"] as const)
  describe(`${kind} hostile payloads`, () => {
    it("stores __proto__ keyed metadata verbatim without polluting any prototype", async () => {
      const directory = await mkdtemp(join(tmpdir(), "session-proto-"));

      try {
        const { service, host } = await openService(kind, directory);
        value(
          await service.create({
            id: "proto",
            metadata: JSON.parse('{"__proto__": {"polluted": true}, "normal": 2}'),
          }),
        );
        const back = value(await service.get({ id: "proto" }));
        const metadata = back.metadata as Record<string, unknown> | null;
        expect(metadata && typeof metadata === "object").toBe(true);
        expect(Object.keys(metadata!)).toEqual(["__proto__", "normal"]);
        expect(({} as Record<string, unknown>).polluted).not.toBe(true);
        expect((Object.prototype as unknown as Record<string, unknown>).polluted).not.toBe(true);
        await host.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("rejects float extremes, negative zero and over-deep nesting in entries", async () => {
      const directory = await mkdtemp(join(tmpdir(), "session-extreme-"));

      try {
        const { service, host } = await openService(kind, directory);
        value(await service.create({ id: "one" }));
        const rejected: unknown[] = [
          -0,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
        ];

        for (const [index, data] of rejected.entries()) {
          const result = await service.append({
            id: "one",
            expectedRevision: 0,
            commitId: `x${index}`,
            entries: [{ kind: "event", type: "t", data: data as never }],
          });
          expect(result.ok, `payload ${String(data)}`).toBe(false);
        }

        const finite: unknown[] = [Number.MAX_VALUE, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER];

        for (const [index, data] of finite.entries()) {
          const result = await service.append({
            id: "one",
            expectedRevision: index,
            commitId: `f${index}`,
            entries: [{ kind: "event", type: "t", data: data as never }],
          });
          expect(result.ok, `finite extreme ${String(data)}`).toBe(true);
        }

        const history = value(await service.history({ id: "one", limit: 10 }));
        expect(history.records.map((record) => (record.entry as { data: unknown }).data)).toEqual(
          finite,
        );
        let deep: unknown = { v: 1 };

        for (let depth = 0; depth < 40; depth++) deep = { nested: deep };

        expect(
          (
            await service.append({
              id: "one",
              expectedRevision: 0,
              commitId: "deep",
              entries: [{ kind: "event", type: "t", data: deep as never }],
            })
          ).ok,
        ).toBe(false);
        let overBudget: unknown = { v: 1 };

        for (let depth = 0; depth < 30; depth++) overBudget = { nested: overBudget };

        expect(
          (
            await service.append({
              id: "one",
              expectedRevision: 0,
              commitId: "over",
              entries: [{ kind: "event", type: "t", data: overBudget as never }],
            })
          ).ok,
        ).toBe(false);
        let edge: unknown = { v: 1 };

        for (let depth = 0; depth < 29; depth++) edge = { nested: edge };

        value(
          await service.append({
            id: "one",
            expectedRevision: 3,
            commitId: "edge",
            entries: [{ kind: "event", type: "t", data: edge as never }],
          }),
        );
        await host.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("keeps unicode normalization variants distinct", async () => {
      const directory = await mkdtemp(join(tmpdir(), "session-unicode-"));

      try {
        const { service, host } = await openService(kind, directory);
        value(await service.create({ id: "nfc", metadata: { label: "café" } }));
        value(await service.create({ id: "nfd", metadata: { label: "café" } }));
        const first = value(await service.get({ id: "nfc" }));
        const second = value(await service.get({ id: "nfd" }));
        expect(JSON.stringify(first.metadata) !== JSON.stringify(second.metadata)).toBe(true);
        const textEntry: SessionEntry = {
          kind: "message",
          message: { role: "user", content: [{ type: "text", text: "🎉🇨🇳ok" }] },
        };
        value(await service.create({ id: "emoji" }));
        value(
          await service.append({
            id: "emoji",
            expectedRevision: 0,
            commitId: "e1",
            entries: [textEntry],
          }),
        );
        const walk = value(await service.conversation({ id: "emoji" }));
        expect(walk.nodes[0]!.message.content[0]).toMatchObject({ type: "text", text: "🎉🇨🇳ok" });
        await host.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
