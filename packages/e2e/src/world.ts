import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { createFileAudit, createPluginManager } from "@x-harness/plugin-manager";
import { pluginManagerService } from "@x-harness/plugin-manager";
import type { PluginManagerService } from "@x-harness/plugin-manager";
import { crudDb, type SqliteDb } from "../plugins/contracts.ts";

export const PLUGINS_DIR = fileURLToPath(new URL("../plugins/", import.meta.url));

export function pluginPath(file: string): string {
  return join(PLUGINS_DIR, file);
}

export interface World {
  readonly ctx: Context;
  readonly svc: PluginManagerService;
  dispose(): Promise<void>;
}

export async function createWorld(): Promise<World> {
  const ctx = createContext();
  const dir = await mkdtemp(join(tmpdir(), "xe2e-"));
  const db = new Database(join(dir, "crud.db"));
  try {
    db.run("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)");
    const typed = db as unknown as {
      run(sql: string, ...params: (string | number | null)[]): void;
      query<T>(sql: string): { all(...params: (string | number | null)[]): T[] };
    };
    const executor: SqliteDb = {
      run: (sql, ...params) => typed.run(sql, ...params),
      all: <T>(sql: string, ...params: (string | number | null)[]): T[] => typed.query<T>(sql).all(...params),
    };
    ctx.provide(crudDb, executor);
    await loadPlugins(ctx, [
      createPluginManager({
        ctx,
        roots: [PLUGINS_DIR],
        approveInstall: () => true,
        mode: "process",
        audit: createFileAudit(join(dir, "audit.jsonl")),
      }),
    ]);
  } catch (error) {
    db.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  let disposed = false;
  return {
    ctx,
    svc: ctx.use(pluginManagerService),
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await ctx.dispose();
      } finally {
        db.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export function service<T>(world: World, name: string): T {
  const token = world.svc.serviceToken(name);
  if (token === undefined) throw new Error(`service token missing: ${name}`);
  return world.ctx.use(token as Parameters<typeof world.ctx.use>[0]) as T;
}
