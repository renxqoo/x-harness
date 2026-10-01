import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkClient } from "../client.ts";
import type { SdkEvent } from "../events.ts";

describe("ThreadHandle.events AsyncIterable（§3.5 birth 缓冲契约）", () => {
  it("订阅前事件不丢（birth 缓冲）+ 迭代消费 + break 释放", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-events-"));
    const events: SdkEvent[] = [];
    const sdk = createSdkClient({
      mode: "in-process",
      agentDir: join(root, "agent"),
      sessionsRoot: join(root, "sessions"),
      env: { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "hello-birth-buffer" }]) },
      onEvent: (event) => events.push(event),
    });
    try {
      const started = await sdk.startThread({ cwd: root, trusted: false });
      if (!started.ok) throw new Error(started.reason.message);
      const thread = started.value;
      const report = await thread.send("hi", { sendId: "q1", timeoutMs: 30_000 });
      expect(report.ok && report.value.ok).toBe(true);
      const seen: string[] = [];
      for await (const event of thread.events) {
        seen.push(event.kind);
        if (event.kind === "settled" && event.sendId === "q1") break;
      }
      expect(seen).toContain("stream");
      expect(seen).toContain("session");
      expect(seen.filter((k) => k === "settled").length).toBeGreaterThanOrEqual(1);
      await thread.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("stop 后迭代器自然终止（done）", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-events2-"));
    const sdk = createSdkClient({
      mode: "in-process",
      agentDir: join(root, "agent"),
      sessionsRoot: join(root, "sessions"),
      env: { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "ok" }]) },
      onEvent: () => {},
    });
    try {
      const started = await sdk.startThread({ cwd: root, trusted: false });
      if (!started.ok) throw new Error(started.reason.message);
      const thread = started.value;
      await thread.send("prime", { timeoutMs: 30_000 });
      const iterator = thread.events[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      await thread.stop();
      let tail = await iterator.next();
      while (tail.done !== true) {
        tail = await iterator.next();
      }
      expect(tail.done).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
