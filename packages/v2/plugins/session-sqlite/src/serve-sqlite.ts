import { Database } from "bun:sqlite";

interface Request { readonly id: number; readonly text?: string; readonly values?: readonly (string | number | null)[]; readonly close?: boolean }
interface Port { postMessage(value: unknown): void; on(event: "message", listener: (input: Request) => void): unknown; close(): void }
export function serveSqlite(port: Port, options: { path: string; timeout: number }): void {
  let db: Database | undefined;
  try {
    db = new Database(options.path, { strict: true, create: true });
    db.run(`PRAGMA busy_timeout=${options.timeout}`);
    const journal = db.query("PRAGMA journal_mode=WAL").get() as { journal_mode: string };
    if (options.path !== ":memory:" && journal.journal_mode !== "wal") throw undefined;
    db.run("PRAGMA synchronous=FULL"); db.run("PRAGMA foreign_keys=ON");
    port.postMessage({ id: 0, ok: true, rows: [] });
    port.on("message", (input) => {
      try {
        if (input.close) { db!.close(); port.postMessage({ id: input.id, ok: true, rows: [] }); port.close(); return; }
        const rows = db!.query(input.text!.replace(/\$(\d+)/g, "?$1")).all(...input.values ?? []);
        port.postMessage({ id: input.id, ok: true, rows });
      } catch { port.postMessage({ id: input.id, ok: false }); }
    });
  } catch { try { db?.close(); } catch {} port.postMessage({ id: 0, ok: false }); port.close(); }
}
