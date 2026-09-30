import { describe, expect, it } from "vitest";
import { readLimits, clampIdleRetireMs, clampRssRetireBytes, clampConfirmTimeoutMs } from "../limits.ts";

describe("sdk limits", () => {
  it("defaults match hub values", () => {
    const limits = readLimits({});
    expect(limits.maxThreads).toBe(32);
    expect(limits.idleRetireMs).toBe(900_000);
    expect(limits.rssRetireBytes).toBe(0);
    expect(limits.bashTimeoutMs).toBe(600_000);
    expect(limits.workerStaleMs).toBe(30_000);
    expect(limits.workerExitTimeoutMs).toBe(10_000);
    expect(limits.pendingCommandsCap).toBe(65_536);
    expect(limits.eventQueueCapacity).toBe(1024);
  });

  it("reads env overrides", () => {
    const limits = readLimits({ HUB_MAX_THREADS: "4", HUB_IDLE_RETIRE_MS: "5000" });
    expect(limits.maxThreads).toBe(4);
    expect(limits.idleRetireMs).toBe(5000);
  });

  it("clamps idle window with 0 = off", () => {
    expect(clampIdleRetireMs(10)).toBe(1_000);
    expect(clampIdleRetireMs(1e15)).toBe(24 * 60 * 60 * 1000);
    expect(clampIdleRetireMs(0)).toBe(0);
  });

  it("confirm timeout supports 0 = no timeout", () => {
    expect(clampConfirmTimeoutMs(0)).toBe(0);
    expect(clampConfirmTimeoutMs(10)).toBe(1_000);
  });

  it("requeue and shutdown budget limits are present", () => {
    const limits = readLimits({});
    expect(limits.requeueMaxPerThread).toBe(1024);
    expect(limits.requeueMaxBytesPerThread).toBe(4 * 1024 * 1024);
    expect(limits.shutdownBudgetMs).toBe(30_000);
  });

  it("clamps rss window or disables with zero", () => {
    expect(clampRssRetireBytes(0)).toBe(0);
    expect(clampRssRetireBytes(1)).toBe(256 * 1024 * 1024);
  });

  it("ignores garbage env values", () => {
    const limits = readLimits({ HUB_MAX_THREADS: "abc", HUB_IDLE_RETIRE_MS: "" });
    expect(limits.maxThreads).toBe(32);
    expect(limits.idleRetireMs).toBe(900_000);
  });
});
