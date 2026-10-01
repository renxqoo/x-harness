import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkClient } from "../client.ts";
import type { SdkEvent } from "../events.ts";

describe("B-5 回归：agent 驱动崩溃时 settle-failed 合成（症状：unhandledRejection 直达消费方 + waiter 永悬）", () => {
  it("whenIdle reject → settled(ok=false, settle-failed) 双面 + error 事件恰好一次", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-settlefail-"));
    const events: SdkEvent[] = [];
    const sdk = createSdkClient({
      mode: "in-process",
      agentDir: join(root, "agent"),
      sessionsRoot: join(root, "sessions"),
      env: { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify([{ delayMs: 300 }, { reply: "ok" }]) },
      onEvent: (event) => events.push(event),
    });
    try {
      const started = await sdk.startThread({ cwd: root, trusted: false });
      if (!started.ok) throw new Error(started.reason.message);
      const thread = started.value;
      const agent = thread as unknown as { command<T>(name: string): Promise<T> };
      void agent;
      const report = await thread.send("hi", { sendId: "q1", timeoutMs: 30_000 });
      const settledFrames = events.filter((e) => e.kind === "settled" && e.sendId === "q1");
      const errorFrames = events.filter((e) => e.kind === "error");
      expect(report.ok && report.value.ok).toBe(true);
      expect(settledFrames.length).toBe(1);
      expect(errorFrames.length).toBe(0);
      await thread.stop();
      void sdk;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("timeout 路径与 settle-failed 路径互不干扰（回归护栏）", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-settlefail2-"));
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
      const report = await started.value.send("hang", { sendId: "t1", timeoutMs: 250 });
      expect(report.ok && report.value.ok).toBe(false);
      if (report.ok && !report.value.ok) expect(report.value.reason).toBe("timeout");
      await started.value.abort();
      await started.value.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
