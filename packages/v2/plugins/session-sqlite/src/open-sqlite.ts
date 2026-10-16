import { Worker } from "node:worker_threads";
import { mkdir, open, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import type { Database, Parameters, Query, Row } from "../../session-storage-sql/src/index";

export async function openSqlite(path: string, timeout: number): Promise<Database> {
  if (path !== ":memory:") {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, "a", 0o600); await file.close(); await chmod(path, 0o600);
  }
  const filename = import.meta.url.endsWith(".ts") ? "./sqlite-worker.ts" : "./sqlite-worker.js";
  const worker = new Worker(new URL(filename, import.meta.url), { workerData: { path, timeout } });
  const pending = new Map<number, { resolve(rows: readonly Row[]): void; reject(): void }>(); let next = 0; let stopped = false;
  const exited = new Promise<void>((resolve) => worker.once("exit", () => { stopped = true; for (const item of pending.values()) item.reject(); pending.clear(); resolve(); }));
  worker.on("error", () => { stopped = true; for (const item of pending.values()) item.reject(); pending.clear(); });
  worker.on("message", (response: { id: number; ok: boolean; rows: readonly Row[] }) => { const item = pending.get(response.id); pending.delete(response.id); if (response.ok) item?.resolve(response.rows); else item?.reject(); });
  const ready = new Promise<readonly Row[]>((resolve, reject) => pending.set(0, { resolve, reject }));
  try { await ready; } catch { await worker.terminate(); throw undefined; }
  const execute = (text?: string, values?: Parameters): Promise<readonly Row[]> => {
    if (stopped) return Promise.reject();
    return new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); worker.postMessage({ id, text, values, close: text === undefined }); });
  };
  const query: Query = { all: execute, lock: () => Promise.resolve() };
  return {
    async transaction(write, run) {
      await execute(write ? "BEGIN IMMEDIATE" : "BEGIN");
      try { const value = await run(query); await execute("COMMIT"); return value; }
      catch (error) { try { await execute("ROLLBACK"); } catch { await worker.terminate(); } throw error; }
    },
    async close() { try { if (!stopped) await execute(); await exited; } finally { if (!stopped) await worker.terminate(); } },
  };
}
