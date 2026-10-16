import { expect, it } from "vitest";
import { serveSqlite } from "../serve-sqlite";

it("SQLite worker protocol supports parameterized transactions and rejects SQL failures without exposing details", () => {
  const messages: unknown[] = []; let listener!: (input: { id: number; text?: string; values?: (string | number | null)[]; close?: boolean }) => void; let closed = false;
  serveSqlite({ postMessage(value) { messages.push(value); }, on(_event, callback) { listener = callback; }, close() { closed = true; } }, { path: ":memory:", timeout: 100 });
  expect(messages.shift()).toEqual({ id: 0, ok: true, rows: [] });
  listener({ id: 1, text: "CREATE TABLE sample(id TEXT PRIMARY KEY)" }); listener({ id: 2, text: "BEGIN IMMEDIATE" }); listener({ id: 3, text: "INSERT INTO sample(id) VALUES($1)", values: ["a"] }); listener({ id: 4, text: "ROLLBACK" }); listener({ id: 5, text: "SELECT * FROM sample" });
  expect(messages.pop()).toEqual({ id: 5, ok: true, rows: [] });
  listener({ id: 6, text: "SELECT secret FROM missing" }); expect(messages.pop()).toEqual({ id: 6, ok: false });
  listener({ id: 7, close: true }); expect(messages.pop()).toEqual({ id: 7, ok: true, rows: [] }); expect(closed).toBe(true);
});
it("worker initialization failure reports a bounded error and closes its port", () => {
  const messages: unknown[] = []; let closed = false;
  serveSqlite({ postMessage(value) { messages.push(value); }, on() { throw new Error("Must not accept queries"); }, close() { closed = true; } }, { path: "/dev/null/cannot-open.sqlite", timeout: 100 });
  expect(messages).toEqual([{ id: 0, ok: false }]); expect(closed).toBe(true);
});
