import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { openSqlite } from "../open-sqlite";
import { openSqlStore, defaultStorageLimits } from "../../../session-storage-sql/src/index";

it("failed SQLite close terminates its worker and concurrent store close can subsequently retry", async () => {
  const originalPost = Reflect.get(Worker.prototype, "postMessage") as Worker["postMessage"]; const originalTerminate = Reflect.get(Worker.prototype, "terminate") as Worker["terminate"]; let terminations = 0;
  const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, input: unknown, transferList) {
    const message = input as { close?: boolean; id: number };
    if (message.close) { queueMicrotask(() => { this.emit("message", { id: message.id, ok: false }); }); return; }
    Reflect.apply(originalPost, this, [input, transferList]);
  });
  const terminate = vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) { terminations++; return Reflect.apply(originalTerminate, this, []); });
  try {
    const database = await openSqlite(":memory:", 100); await expect(database.close()).rejects.toBeUndefined(); expect(terminations).toBe(1); await database.close(); expect(terminations).toBe(1);
    const store = openSqlStore(await openSqlite(":memory:", 100), defaultStorageLimits, 1);
    expect(await Promise.all([store.close(), store.close()])).toEqual([{ ok: false, error: { source: "session", code: "storage-unavailable" } }, { ok: false, error: { source: "session", code: "storage-unavailable" } }]); expect(terminations).toBe(2);
    expect(await store.close()).toEqual({ ok: true, value: undefined }); expect(await store.close()).toEqual({ ok: true, value: undefined }); expect(terminations).toBe(2);
    expect(await store.run({ write: false }, async () => ({ ok: true, value: undefined }))).toMatchObject({ ok: false, error: { code: "closed" } });
  } finally { post.mockRestore(); terminate.mockRestore(); }
});

it("worker failure rejects pending transactions and terminates the failed transport", async () => {
  const original = Reflect.get(Worker.prototype, "postMessage") as Worker["postMessage"];
  const db = await openSqlite(":memory:", 100);
  const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, input: unknown, transferList) {
    if ((input as { text?: string }).text === "SELECT waiting") { queueMicrotask(() => this.emit("error", new Error("transport failed"))); return; }
    Reflect.apply(original, this, [input, transferList]);
  });
  try { await expect(db.transaction(false, (query) => query.all("SELECT waiting"))).rejects.toBeUndefined(); }
  finally { post.mockRestore(); await db.close(); }
});
