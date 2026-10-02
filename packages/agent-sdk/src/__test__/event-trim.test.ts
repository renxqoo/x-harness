import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkClient, attachExecutor } from "../index.ts";
import type { SdkEvent } from "../events.ts";

describe("事件面分级丢弃（capacity 消费 + 终态保护）", () => {
  it("容量接 limits.eventQueueCapacity；溢出优先丢可丢类，终态类保留", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-trim-"));
    const seen: SdkEvent[] = [];
    const sdk = createSdkClient({
      mode: "in-process",
      agentDir: join(root, "agent"),
      sessionsRoot: join(root, "sessions"),
      env: { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "ok" }]) },
      limits: { eventQueueCapacity: 16 },
      onEvent: (event) => seen.push(event),
    });
    const probe = attachExecutor(sdk as never, {
      mode: "in-process",
      agentDir: join(root, "agent"),
      sessionsRoot: join(root, "sessions"),
      env: { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "ok" }]) },
    });
    try {
      const started = await probe.startThread({ cwd: root, trusted: false });
      if (!started.ok) throw new Error(started.reason.message);
      const thread = started.value;
      const report = await thread.send("hi", { sendId: "q1", timeoutMs: 30_000 });
      expect(report.ok && report.value.ok).toBe(true);
      const liveEntry = [...probe.internal.live.values()][0];
      if (liveEntry !== undefined) {
        expect(liveEntry.eventBuffer.length).toBeLessThanOrEqual(16);
        const settledKept = liveEntry.eventBuffer.some((e) => e.kind === "settled" && e.sendId === "q1");
        expect(settledKept).toBe(true);
      }
      await thread.stop();
      await sdk.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("纯终态洪泛（无脏垫）不超限截断兜底仍生效", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-trim2-"));
    const sdk = createSdkClient({
      mode: "in-process",
      agentDir: join(root, "agent"),
      sessionsRoot: join(root, "sessions"),
      env: { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "ok" }]) },
      limits: { eventQueueCapacity: 4 },
      onEvent: () => {},
    });
    const probe = attachExecutor(sdk as never, {
      mode: "in-process",
      agentDir: join(root, "agent"),
      sessionsRoot: join(root, "sessions"),
      env: { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "ok" }, { reply: "ok" }, { reply: "ok" }, { reply: "ok" }, { reply: "ok" }, { reply: "ok" }, { reply: "ok" }]) },
    });
    try {
      const started = await probe.startThread({ cwd: root, trusted: false });
      if (!started.ok) throw new Error(started.reason.message);
      const thread = started.value;
      for (let i = 0; i < 6; i += 1) {
        await thread.send(`flood-${String(i)}`, { timeoutMs: 30_000 });
      }
      const liveEntry = [...probe.internal.live.values()][0];
      if (liveEntry !== undefined) {
        expect(liveEntry.eventBuffer.length).toBeLessThanOrEqual(4);
        const last = liveEntry.eventBuffer.at(-1);
        expect(last?.kind).toBe("settled");
      }
      await thread.stop();
      await sdk.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
