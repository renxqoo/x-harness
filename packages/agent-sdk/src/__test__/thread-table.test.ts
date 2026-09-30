import { describe, expect, it } from "vitest";
import { createThreadTable } from "../thread-table.ts";

describe("thread table", () => {
  it("inserts live entries and tracks occupancy of session paths", () => {
    const table = createThreadTable();
    table.insert({ threadId: "s1", cwd: "/a", sessionPath: "/root/s1/events.jsonl", state: "live", keepalive: false, trusted: true });
    expect(table.holderOf("/root/s1/events.jsonl")).toBe("s1");
    expect(table.liveCount()).toBe(1);
  });

  it("holderOf returns undefined for free paths", () => {
    const table = createThreadTable();
    expect(table.holderOf("/root/none/events.jsonl")).toBeUndefined();
  });

  it("update moves occupancy when sessionPath changes", () => {
    const table = createThreadTable();
    table.insert({ threadId: "s1", cwd: "/a", sessionPath: "/root/s1/events.jsonl", state: "live", keepalive: false, trusted: false });
    table.update("s1", { sessionPath: "/root/s2/events.jsonl" });
    expect(table.holderOf("/root/s1/events.jsonl")).toBeUndefined();
    expect(table.holderOf("/root/s2/events.jsonl")).toBe("s1");
  });

  it("remove releases occupancy", () => {
    const table = createThreadTable();
    table.insert({ threadId: "s1", cwd: "/a", sessionPath: "/root/s1/events.jsonl", state: "live", keepalive: false, trusted: false });
    table.remove("s1");
    expect(table.get("s1")).toBeUndefined();
    expect(table.holderOf("/root/s1/events.jsonl")).toBeUndefined();
  });

  it("applyHeartbeat updates idle/streaming/rss and lastBeatAt", () => {
    const table = createThreadTable();
    table.insert({ threadId: "s1", cwd: "/a", sessionPath: "/root/s1/events.jsonl", state: "live", keepalive: false, trusted: false });
    const before = table.get("s1")?.lastBeatAt;
    table.applyHeartbeat("s1", { idleMs: 42, streaming: true, sessionPath: null, rssBytes: 123 });
    const entry = table.get("s1");
    expect(entry?.idleMs).toBe(42);
    expect(entry?.isStreaming).toBe(true);
    expect(entry?.rssBytes).toBe(123);
    expect(entry?.lastBeatAt).toBeGreaterThanOrEqual(before ?? 0);
  });

  it("applyHeartbeat with a new sessionPath rebinds occupancy", () => {
    const table = createThreadTable();
    table.insert({ threadId: "s1", cwd: "/a", sessionPath: "/root/s1/events.jsonl", state: "live", keepalive: false, trusted: false });
    table.applyHeartbeat("s1", { idleMs: 0, streaming: false, sessionPath: "/root/s9/events.jsonl", rssBytes: null });
    expect(table.holderOf("/root/s1/events.jsonl")).toBeUndefined();
    expect(table.holderOf("/root/s9/events.jsonl")).toBe("s1");
  });

  it("rekey replaces the old thread id and keeps the new occupancy", () => {
    const table = createThreadTable();
    table.insert({ threadId: "s1", cwd: "/a", sessionPath: "/root/s1/events.jsonl", state: "live", keepalive: false, trusted: true });
    table.rekey("s1", { threadId: "s2", sessionPath: "/root/s2/events.jsonl", cwd: "/a", trusted: true, state: "live" });
    expect(table.get("s1")).toBeUndefined();
    expect(table.holderOf("/root/s1/events.jsonl")).toBeUndefined();
    expect(table.get("s2")?.state).toBe("live");
    expect(table.holderOf("/root/s2/events.jsonl")).toBe("s2");
  });

  it("applyHeartbeat on unknown thread is a no-op", () => {
    const table = createThreadTable();
    expect(() => table.applyHeartbeat("ghost", { idleMs: 1, streaming: false, sessionPath: null, rssBytes: null })).not.toThrow();
  });

  it("evicts oldest non-live entries beyond the cap", () => {
    const table = createThreadTable();
    for (let i = 0; i < 1100; i += 1) {
      table.insert({ threadId: `p${i}`, cwd: "/a", sessionPath: null, state: "parked", trusted: false, keepalive: false });
    }
    expect(table.list().length).toBeLessThanOrEqual(1024);
    expect(table.get("p0")).toBeUndefined();
    expect(table.get("p1099")).toBeDefined();
  });
});
