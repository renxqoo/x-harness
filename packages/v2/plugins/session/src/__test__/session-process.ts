import { createHost } from "../../../../core/src/index";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import type { FixtureOptions } from "./helpers";
import type { SessionResult } from "../index";

function value<T>(result: SessionResult<T>): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; }
const entry = await import(process.argv[2]!); const options = JSON.parse(process.argv[3]!) as FixtureOptions; const mode = process.argv[4]!;
const host = value(createHost({ limits: { callTimeoutMs: 30000, closeTimeoutMs: 30000 } }));
const folder = options.storage.kind === "sqlite" ? "session-sqlite" : "session-postgres";
const form = process.argv[2]!.endsWith(".ts") ? "src/index.ts" : "dist/index.js";
const provider = await import(fileURLToPath(new URL(`../../../${folder}/${form}`, import.meta.url)));
const backend = options.storage.kind === "sqlite" ? provider.createSqliteSessionPlugin({ path: options.storage.path }) : provider.createPostgresSessionPlugin({ url: options.storage.url });
const { storage: _storage, ...sessionOptions } = options;
value(await host.install([value(backend), value(entry.createSessionPlugin(sessionOptions))])); const service = value(host.use(entry.session)) as import("../index").SessionService;
value(await service.create({ id: "one" }));
const start = new Promise<void>((resolve) => process.once("message", () => resolve())); process.send?.({ phase: "ready" }); await start;
if (mode === "uncommitted") {
  if (options.storage.kind === "sqlite") {
    const db = new Database(options.storage.path); db.exec("BEGIN IMMEDIATE"); db.query("UPDATE xh_session_heads SET revision=1 WHERE namespace=?1 AND id='one'").run(options.namespace!);
    process.send?.({ phase: "uncommitted" }); await new Promise(() => {});
  } else {
    const db = new SQL(options.storage.url); await db.begin(async (tx) => { await tx.unsafe("UPDATE xh_session_heads SET revision=1 WHERE namespace=$1 AND id='one'", [options.namespace!]); process.send?.({ phase: "uncommitted" }); await new Promise(() => {}); });
  }
} else {
  const commitId = process.argv[5] ?? "once";
  const result = await service.append({ id: "one", expectedRevision: 0, commitId, entries: [{ kind: "message", message: { role: "user", content: [{ type: "text", text: commitId }] } }] });
  process.send?.({ phase: "result", result });
  if (mode === "crash") await new Promise(() => {});
  value(await host.close()); process.disconnect?.();
}
