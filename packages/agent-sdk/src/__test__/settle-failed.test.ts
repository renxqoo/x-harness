import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkClient, attachExecutor } from "../index.ts";
import type { SdkEvent } from "../events.ts";

describe("settled 语义护栏（I3 正常路径）", () => {
  it("正常回合：settled 恰好一次、error 零次（B-5 catch 为防御位，whenIdle 现实现不可 reject——见 §3d 登记）", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-settlefail-"));
    const events: SdkEvent[] = [];
    const sdk = createSdkClient({
      mode: "in-process",
      agentDir: join(root, "agent"),
      sessionsRoot: join(root, "sessions"),
      env: { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "ok" }]) },
      onEvent: (event) => events.push(event),
    });
    try {
      const started = await sdk.startThread({ cwd: root, trusted: false });
      if (!started.ok) throw new Error(started.reason.message);
      const report = await started.value.send("hi", { sendId: "q1", timeoutMs: 30_000 });
      const settledFrames = events.filter((e) => e.kind === "settled" && e.sendId === "q1");
      const errorFrames = events.filter((e) => e.kind === "error");
      expect(report.ok && report.value.ok).toBe(true);
      expect(settledFrames.length).toBe(1);
      expect(errorFrames.length).toBe(0);
      await started.value.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("catch 防御位真触发：settleFromAnchor 抛错（注入污染 session.events 的假 run）→ settled(ok=false, settle-failed)", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-settlefail2-"));
    const events: SdkEvent[] = [];
    const options = {
      mode: "in-process" as const,
      agentDir: join(root, "agent"),
      sessionsRoot: join(root, "sessions"),
      env: { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "ok" }]) },
      onEvent: (event: SdkEvent) => events.push(event),
    };
    const sdk = createSdkClient(options);
    const probe = attachExecutor(sdk as never, options);
    try {
      const started = await probe.startThread({ cwd: root, trusted: false });
      if (!started.ok) throw new Error(started.reason.message);
      const thread = started.value;
      const liveMap = probe.internal.live;
      const liveEntry = [...liveMap.values()][0];
      if (liveEntry === undefined) throw new Error("no live thread");
      const realRun = liveEntry.run;
      let poisoned = false;
      const wrappedRun = new Proxy(realRun, {
        get(target, prop, receiver) {
          if (prop === "handle" && poisoned) throw new Error("handle poisoned");
          return Reflect.get(target, prop, receiver);
        },
      }) as typeof realRun;
      (liveEntry as { run: typeof realRun }).run = wrappedRun;
      const sendPromise = thread.send("trigger", { sendId: "q2", timeoutMs: 30_000 });
      poisoned = true;
      const report = await Promise.race([
        sendPromise,
        new Promise<"HANG">((resolve) => {
          setTimeout(() => resolve("HANG"), 8000).unref?.();
        }),
      ]);
      expect(report).not.toBe("HANG");
      if (report !== "HANG") {
        expect(report.ok && report.value.ok).toBe(false);
        if (report.ok && !report.value.ok) expect(report.value.reason).toBe("settle-failed");
      }
      await thread.stop();
      await probe.shutdownAll();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
