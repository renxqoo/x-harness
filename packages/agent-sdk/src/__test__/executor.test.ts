import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkClient } from "../client.ts";
import { attachExecutor } from "../executor.ts";
import type { SdkEvent } from "../events.ts";

async function makeWorld() {
  const root = await mkdtemp(join(tmpdir(), "sdk-exec-"));
  const events: SdkEvent[] = [];
  const client = createSdkClient({
    mode: "in-process",
    agentDir: join(root, "agent"),
    sessionsRoot: join(root, "sessions"),
    env: {
      HUB_WORKER_PROVIDER: "script",
      HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "hello from script" }, { reply: "second" }, { reply: "third" }, { reply: "fourth" }, { reply: "fifth" }, { reply: "sixth" }]),
    },
    onEvent: (event) => events.push(event),
  });
  const executor = attachExecutor(client, {
    mode: "in-process",
    agentDir: join(root, "agent"),
    sessionsRoot: join(root, "sessions"),
    env: { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "hello from script" }, { reply: "second" }, { reply: "third" }, { reply: "fourth" }, { reply: "fifth" }, { reply: "sixth" }]) },
  });
  return { root, client, executor, events, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("in-process executor minimal face", () => {
  it("startThread → send → settled(ok) → retire round-trip", async () => {
    const w = await makeWorld();
    try {
      const started = await w.executor.startThread({ cwd: w.root, trusted: false });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const thread = started.value;
      expect(thread.state).toBe("live");
      expect(thread.info.sessionPath).toContain("events.jsonl");

      const sent = await thread.send("hi", { sendId: "q1", timeoutMs: 30_000 });
      expect(sent.ok).toBe(true);
      if (sent.ok) {
        expect(sent.value.sendId).toBe("q1");
        expect(sent.value.ok).toBe(true);
      }

      const retire = await thread.retire();
      expect(retire.ok).toBe(true);
      expect(thread.state).toBe("parked");
      const listed = w.client.listThreads();
      expect(listed.ok && listed.value.length).toBe(1);
    } finally {
      await w.cleanup();
    }
  }, 60_000);

  it("resumeThread wakes a parked thread", async () => {
    const w = await makeWorld();
    try {
      const started = await w.executor.startThread({ cwd: w.root, trusted: false });
      if (!started.ok) throw new Error(started.reason.message);
      const first = started.value;
      const threadId = first.threadId;
      await first.send("hi", { timeoutMs: 30_000 });
      await first.retire();

      const resumed = await w.executor.resumeThread({ threadId, cwd: w.root });
      expect(resumed.ok).toBe(true);
      if (resumed.ok) expect(resumed.value.state).toBe("live");

      const again = await w.executor.resumeThread({ threadId, cwd: w.root });
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.reason.code).toBe("already_open");
      await (resumed.ok ? resumed.value.stop() : Promise.resolve());
    } finally {
      await w.cleanup();
    }
  }, 60_000);

  it("abort resolves and thread stays usable", async () => {
    const w = await makeWorld();
    try {
      const started = await w.executor.startThread({ cwd: w.root, trusted: false });
      if (!started.ok) throw new Error(started.reason.message);
      const thread = started.value;
      const aborted = await thread.abort("test-abort");
      expect(aborted.ok).toBe(true);
      const after = await thread.send("still alive", { timeoutMs: 30_000 });
      expect(after.ok && after.value.ok).toBe(true);
      await thread.stop();
    } finally {
      await w.cleanup();
    }
  }, 60_000);

  it("steer and followup entrances drive turns", async () => {
    const w = await makeWorld();
    try {
      const started = await w.executor.startThread({ cwd: w.root, trusted: false });
      if (!started.ok) throw new Error(started.reason.message);
      const thread = started.value;
      const steered = await thread.steer("inject", { timeoutMs: 30_000 });
      expect(steered.ok && steered.value.ok).toBe(true);
      const queued = await thread.followup("next turn", { timeoutMs: 30_000 });
      expect(queued.ok && queued.value.ok).toBe(true);
      await thread.stop();
    } finally {
      await w.cleanup();
    }
  }, 60_000);

  it("garbage threadId fails with session_unreadable", async () => {
    const w = await makeWorld();
    try {
      const result = await w.executor.resumeThread({ threadId: "no_such_session", cwd: w.root });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.code).toBe("session_unreadable");
    } finally {
      await w.cleanup();
    }
  });

  it("thread limit rejects startThread", async () => {
    const w = await makeWorld();
    try {
      w.client.limits.setIdleRetireMs(0);
      const first = await w.executor.startThread({ cwd: w.root, trusted: false });
      expect(first.ok).toBe(true);
      if (first.ok) await first.value.stop();
      const limited = await w.executor.startThread({ cwd: w.root, trusted: false });
      expect(limited.ok).toBe(true);
    } finally {
      await w.cleanup();
    }
  }, 60_000);
});
