import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "../../../../core/src/index";
import { session } from "../index";
import { makePlugins, value, message, event } from "./helpers";

async function openClients(path: string, count: number, namespace: string) {
  const clients = [];
  for (let index = 0; index < count; index++) {
    const host = value(createHost({ limits: { callTimeoutMs: 30000, closeTimeoutMs: 30000 } }));
    value(await host.install(makePlugins({ namespace, storage: { kind: "sqlite", path } })));
    clients.push({ host, service: value(host.use(session)) });
  }
  return clients;
}

it("racing appends and a fork publish an exact immutable prefix under real sqlite contention", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-race-")); const path = join(directory, "data.sqlite"); const namespace = crypto.randomUUID();
  const clients = await openClients(path, 3, namespace);
  try {
    const writer = clients[0]!; const forker = clients[1]!; const racer = clients[2]!;
    value(await writer.service.create({ id: "source" }));
    value(await writer.service.append({ id: "source", expectedRevision: 0, commitId: "seed", entries: [message("one")] }));
    const race = Promise.all([
      racer.service.append({ id: "source", expectedRevision: 1, commitId: "extra", entries: [event({ extra: true })] }),
      forker.service.fork({ id: "child", sourceId: "source", throughRevision: 1 }),
    ]);
    const [appended, forked] = await race;
    expect(appended.ok || appended.error.code === "revision-conflict").toBe(true);
    expect(forked.ok || forked.error.code === "capacity-exceeded" || forked.error.code === "storage-unavailable").toBe(true);
    if (forked.ok) {
      expect(forked.value.revision).toBe(1);
      expect(forked.value.parent).toEqual({ id: "source", revision: 1 });
      const child = value(await forker.service.history({ id: "child" })).records;
      expect(child).toHaveLength(1);
      const source = value(await writer.service.history({ id: "source" })).records;
      expect(source[0]!.entry).toEqual(child[0]!.entry);
      expect(source.map((record) => record.seq)).toEqual([1, 2]);
    }
    const finalRevision = value(await writer.service.get({ id: "source" })).revision;
    expect(finalRevision).toBe(2);
  } finally { for (const client of clients) value(await client.host.close()); await rm(directory, { recursive: true, force: true }); }
}, 30000);

it("identical concurrent forks converge on one child and conflicting metadata reports already-exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-fork-")); const path = join(directory, "data.sqlite"); const namespace = crypto.randomUUID();
  const clients = await openClients(path, 3, namespace);
  try {
    value(await clients[0]!.service.create({ id: "source" }));
    value(await clients[0]!.service.append({ id: "source", expectedRevision: 0, commitId: "a", entries: [message("x")] }));
    const same = await Promise.all(clients.map((client) => client.service.fork({ id: "child", sourceId: "source", throughRevision: 1 })));
    expect(same.every((result) => result.ok)).toBe(true);
    const receipts = same.map((result) => JSON.stringify(result.ok ? result.value : result.error));
    expect(new Set(receipts).size).toBe(1);
    expect(value(await clients[0]!.service.get({ id: "child" })).revision).toBe(1);
    expect(await clients[1]!.service.fork({ id: "child", sourceId: "source", throughRevision: 1, metadata: { other: true } })).toMatchObject({ ok: false, error: { code: "already-exists" } });
  } finally { for (const client of clients) value(await client.host.close()); await rm(directory, { recursive: true, force: true }); }
}, 30000);

it("identical concurrent creates converge on one session and conflicting metadata reports already-exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-create-")); const path = join(directory, "data.sqlite"); const namespace = crypto.randomUUID();
  const clients = await openClients(path, 2, namespace);
  try {
    const same = await Promise.all(clients.map((client) => client.service.create({ id: "shared", metadata: { origin: "both" } })));
    expect(same.filter((result) => result.ok)).toHaveLength(2);
    expect(same.every((result) => result.ok && result.value.revision === 0)).toBe(true);
    expect(await clients[0]!.service.create({ id: "shared", metadata: { origin: "different" } })).toMatchObject({ ok: false, error: { code: "already-exists" } });
  } finally { for (const client of clients) value(await client.host.close()); await rm(directory, { recursive: true, force: true }); }
}, 30000);

it("repeating a fork after the source grew keeps the original immutable prefix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-prefix-")); const path = join(directory, "data.sqlite"); const namespace = crypto.randomUUID();
  const clients = await openClients(path, 2, namespace);
  try {
    value(await clients[0]!.service.create({ id: "source" }));
    value(await clients[0]!.service.append({ id: "source", expectedRevision: 0, commitId: "a", entries: [message("one")] }));
    const first = value(await clients[0]!.service.fork({ id: "child", sourceId: "source", throughRevision: 1 }));
    value(await clients[1]!.service.append({ id: "source", expectedRevision: 1, commitId: "b", entries: [message("two")] }));
    const repeat = value(await clients[1]!.service.fork({ id: "child", sourceId: "source", throughRevision: 1 }));
    expect(repeat).toEqual(first);
    expect(value(await clients[1]!.service.history({ id: "child" })).records).toHaveLength(1);
    expect(value(await clients[1]!.service.get({ id: "source" })).revision).toBe(2);
    expect(await clients[1]!.service.fork({ id: "wider", sourceId: "source", throughRevision: 2 })).toMatchObject({ ok: true, value: { revision: 2 } });
  } finally { for (const client of clients) value(await client.host.close()); await rm(directory, { recursive: true, force: true }); }
}, 30000);
