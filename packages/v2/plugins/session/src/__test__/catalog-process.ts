import { createHost } from "../../../../core/src/index";
import type { Result } from "../../../../core/src/index";
import type { SessionOptions } from "../index";
import type { BackendOptions } from "./helpers";
function value<T, E>(result: Result<T, E>): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; }
const [entry, backendEntry, raw] = process.argv.slice(2) as [string, string, string]; const options = JSON.parse(raw) as { session: SessionOptions; storage: BackendOptions | { kind: "jsonl"; path: string } };
const domain = await import(entry) as typeof import("../index"); const backend = await import(backendEntry); const host = value(createHost());
try {
  const storage = (() => {
    if (options.storage.kind === "sqlite") return (backend as typeof import("../../../session-sqlite/src/index")).createSqliteSessionPlugin({ path: options.storage.path });
    if (options.storage.kind === "postgres") return (backend as typeof import("../../../session-postgres/src/index")).createPostgresSessionPlugin({ url: options.storage.url });
    return (backend as typeof import("../../../session-jsonl/src/index")).createJsonlSessionPlugin({ path: options.storage.path });
  })();
  value(await host.install([value(storage), value(domain.createSessionPlugin(options.session))])); const service = value(host.use(domain.session)); const first = value(await service.list({ limit: 1 })); const second = first.next ? value(await service.list({ after: first.next })) : { sessions: [] }; process.stdout.write(JSON.stringify({ sessions: [...first.sessions, ...second.sessions], next: second.next }));
} finally { value(await host.close()); }
