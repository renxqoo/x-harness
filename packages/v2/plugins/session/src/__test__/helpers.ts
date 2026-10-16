import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, inject } from "vitest";
import { createHost } from "../../../../core/src/index";
import type { Result } from "../../../../core/src/index";
import { createSessionPlugin, session } from "../index";
import type { SessionOptions, SessionEntry } from "../index";

import { createSqliteSessionPlugin } from "../../../session-sqlite/src/index";
import { createPostgresSessionPlugin } from "../../../session-postgres/src/index";

export type BackendOptions = { kind: "sqlite"; path: string } | { kind: "postgres"; url: string };
export interface FixtureOptions extends SessionOptions { readonly storage: BackendOptions }
export function makePlugins(options: FixtureOptions) {
  const { storage, ...sessionOptions } = options;
  const backend = storage.kind === "sqlite" ? createSqliteSessionPlugin({ path: storage.path }) : createPostgresSessionPlugin({ url: storage.url });
  return [value(backend), value(createSessionPlugin(sessionOptions))];
}
export function value<T, E>(result: Result<T, E>): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; }
export function message(text: string, replace?: { startSeq: number; endSeq: number }): SessionEntry { return { kind: "message", message: { role: "user", content: [{ type: "text", text }] }, ...(replace ? { replace } : {}) }; }
export function event(data: import("../../../../core/src/index").JsonValue = null): SessionEntry { return { kind: "event", type: "test/event", data }; }
export function fixtures() {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { let failure: unknown; for (const close of cleanups.splice(0).reverse()) { try { await close(); } catch (error) { failure ??= error; } } if (failure) throw failure; });
  return async (kind: "sqlite" | "postgres", limits?: SessionOptions["limits"]) => {
    const directory = await mkdtemp(join(tmpdir(), "session-contract-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const storage = kind === "sqlite" ? { kind, path: join(directory, "sessions.sqlite") } : { kind, url: inject("sessionPostgresUrl") };
    const options: FixtureOptions = { namespace: crypto.randomUUID(), storage, ...(limits ? { limits } : {}) };
    const open = async (override: Partial<FixtureOptions> = {}) => {
      const host = value(createHost({ limits: { callTimeoutMs: 30000, closeTimeoutMs: 30000 } })); cleanups.push(async () => { value(await host.close()); });
      const plugins = makePlugins({ ...options, ...override }); const plugin = plugins[1]!; value(await host.install(plugins));
      return { host, plugin, service: value(host.use(session)) };
    };
    return { ...await open(), open, options, directory };
  };
}
