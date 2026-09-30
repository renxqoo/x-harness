import { describe, expect, it } from "vitest";
import { createSdkClient } from "../client.ts";
import type { SdkEvent } from "../events.ts";

function makeClient(overrides: Partial<Parameters<typeof createSdkClient>[0]> = {}) {
  const events: SdkEvent[] = [];
  const logs: string[] = [];
  const client = createSdkClient({
    mode: "in-process",
    agentDir: "/tmp/sdk-test/agent",
    sessionsRoot: "/tmp/sdk-test/sessions",
    onEvent: (event) => events.push(event),
    onLog: (message) => logs.push(message),
    ...overrides,
  });
  return { client, events, logs };
}

describe("sdk client basics", () => {
  it("startup and shutdown are idempotent", async () => {
    const { client } = makeClient();
    expect((await client.startup()).ok).toBe(true);
    expect((await client.startup()).ok).toBe(true);
    expect((await client.shutdown()).ok).toBe(true);
    expect((await client.shutdown()).ok).toBe(true);
  });

  it("env snapshot is isolated from later process.env mutation", () => {
    const original = process.env["SDK_TEST_PROBE"];
    process.env["SDK_TEST_PROBE"] = "before";
    const { client } = makeClient();
    process.env["SDK_TEST_PROBE"] = "after";
    expect(client.internal.env["SDK_TEST_PROBE"]).toBe("before");
    if (original === undefined) delete process.env["SDK_TEST_PROBE"];
    else process.env["SDK_TEST_PROBE"] = original;
  });

  it("limits runtime mutation is clamped", () => {
    const { client } = makeClient();
    client.limits.setIdleRetireMs(5);
    expect(client.limits.current().idleRetireMs).toBe(1_000);
    client.limits.setRssRetireBytes(1);
    expect(client.limits.current().rssRetireBytes).toBe(256 * 1024 * 1024);
  });

  it("listThreads starts empty and unknown thread query fails with unknown_thread", () => {
    const { client } = makeClient();
    const listed = client.listThreads();
    expect(listed.ok && listed.value).toEqual([]);
    const result = client.threadInfo("ghost");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("unknown_thread");
  });

  it("thread budget reflects table occupancy", () => {
    const { client } = makeClient({ limits: { maxThreads: 2 } });
    expect(client.internal.threadBudgetAvailable()).toBe(true);
    client.internal.table.insert({ threadId: "a", cwd: "/a", sessionPath: null, state: "live", trusted: false, keepalive: false });
    client.internal.table.insert({ threadId: "b", cwd: "/a", sessionPath: null, state: "live", trusted: false, keepalive: false });
    expect(client.internal.threadBudgetAvailable()).toBe(false);
  });

  it("onEvent receives emitted events", () => {
    const { client, events } = makeClient();
    client.internal.emit({ kind: "error", code: "internal", message: "probe" });
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("error");
  });
});
