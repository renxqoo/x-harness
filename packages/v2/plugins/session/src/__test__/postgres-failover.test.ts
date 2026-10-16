import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
import { SQL } from "bun";
import { expect, it } from "vitest";
import { createHost } from "../../../../core/src/index";
import { session } from "../index";
import { value, message, makePlugins } from "./helpers";
import { startCluster, startReplica } from "./postgres-cluster";

it("a synchronous PostgreSQL standby preserves acknowledged commits after primary loss and the same plugin reconnects", async () => {
  const primary = await startCluster(); let replica: Awaited<ReturnType<typeof startReplica>> | undefined; let endpoint: Awaited<ReturnType<typeof switchableEndpoint>> | undefined; let admin: SQL | undefined; let standby: SQL | undefined;
  const host = value(createHost({ limits: { callTimeoutMs: 30000, closeTimeoutMs: 30000 } }));
  try {
    replica = await startReplica(primary.url); endpoint = await switchableEndpoint(primary.port); admin = new SQL(primary.url); standby = new SQL(replica.url);
    expect((await standby`SELECT pg_is_in_recovery() AS recovering`)[0].recovering).toBe(true);
    await admin.unsafe("ALTER SYSTEM SET synchronous_standby_names='*'"); await admin`SELECT pg_reload_conf()`;
    value(await host.install(makePlugins({ namespace: crypto.randomUUID(), storage: { kind: "postgres", url: endpoint.url } })));
    const service = value(host.use(session)); value(await service.create({ id: "one" })); const input = { id: "one", expectedRevision: 0, commitId: "acknowledged", entries: [message("survives failover")] };
    const committed = value(await service.append(input));
    await primary.stop(); endpoint.disconnect();
    expect(await service.get({ id: "one" })).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });
    await replica.promote(); endpoint.switchTo(replica.port);
    let recovered = await service.getCommit({ id: "one", commitId: "acknowledged" });
    for (let attempt = 0; !recovered.ok && attempt < 5; attempt++) { await Bun.sleep(20); recovered = await service.getCommit({ id: "one", commitId: "acknowledged" }); }
    expect(value(recovered)).toEqual(committed); expect(value(await service.append(input))).toEqual(committed);
    value(await service.append({ id: "one", expectedRevision: 1, commitId: "after-promotion", entries: [message("new primary")] }));
    expect(value(await service.history({ id: "one" })).records.map((record) => record.seq)).toEqual([1, 2]);
  } finally {
    const results = await Promise.allSettled([host.close().then(value), admin?.close({ timeout: 1 }), standby?.close({ timeout: 1 }), endpoint?.close(), replica?.close(), primary.close()]);
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
  }
}, 30000);

async function switchableEndpoint(initial: number) {
  let target = initial; const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect({ host: "127.0.0.1", port: target }); sockets.add(client); sockets.add(upstream);
    const close = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on("error", close); upstream.on("error", close); client.on("close", close); upstream.on("close", close); client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing proxy port");
  const disconnect = () => { for (const socket of sockets) socket.destroy(); sockets.clear(); };
  return { url: `postgres://session_test@127.0.0.1:${address.port}/postgres`, disconnect, switchTo(port: number) { target = port; disconnect(); }, async close() { disconnect(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
