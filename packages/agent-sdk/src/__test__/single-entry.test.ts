import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkClient } from "../client.ts";

describe("单入口 API（B-2）：createSdkClient 直接驱动线程", () => {
  it("startThread → send settled → retire → shutdown 全旅程不触碰 attachExecutor", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-single-"));
    const sdk = createSdkClient({
      mode: "in-process",
      agentDir: join(root, "agent"),
      sessionsRoot: join(root, "sessions"),
      env: { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "hello-single-entry" }]) },
      onEvent: () => {},
    });
    try {
      await sdk.startup();
      const started = await sdk.startThread({ cwd: root, trusted: false });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const thread = started.value;
      const sent = await thread.send("hi", { sendId: "q1", timeoutMs: 30_000 });
      expect(sent.ok && sent.value.ok).toBe(true);
      const retired = await thread.retire();
      expect(retired.ok).toBe(true);
      const shutdownResult = await sdk.shutdown();
      expect(shutdownResult.ok).toBe(true);
      expect(sdk.internal.isShutDown()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("shutdown 结算在途 send（B-1 接线验证）", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-single2-"));
    const sdk = createSdkClient({
      mode: "in-process",
      agentDir: join(root, "agent"),
      sessionsRoot: join(root, "sessions"),
      env: { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify([{ delayMs: 600000 }]) },
      onEvent: () => {},
    });
    try {
      const started = await sdk.startThread({ cwd: root, trusted: false });
      if (!started.ok) throw new Error(started.reason.message);
      const inflight = started.value.send("hang", { sendId: "h1" });
      setTimeout(() => {
        void sdk.shutdown();
      }, 200);
      const race = await Promise.race([inflight, new Promise<"HANG">((resolve) => { setTimeout(() => resolve("HANG"), 5000).unref?.(); })]);
      expect(race).not.toBe("HANG");
      if (race !== "HANG") expect(race.ok && race.value.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
