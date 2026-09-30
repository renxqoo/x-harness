import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkClient } from "../client.ts";
import { attachExecutor } from "../executor.ts";
import type { SdkEvent } from "../events.ts";

function makeEnv(script: unknown): Record<string, string> {
  return { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify(script) };
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const iv = setInterval(() => {
      if (predicate()) {
        clearInterval(iv);
        resolve();
      }
    }, 100);
    setTimeout(() => {
      clearInterval(iv);
      resolve();
    }, timeoutMs).unref?.();
  });
}

async function makeWorld(scriptEnv?: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "sdk-exec-"));
  const events: SdkEvent[] = [];
  const env = scriptEnv ?? makeEnv([{ reply: "hello from script" }, { reply: "second" }, { reply: "third" }, { reply: "fourth" }, { reply: "fifth" }, { reply: "sixth" }]);
  const client = createSdkClient({
    mode: "in-process",
    agentDir: join(root, "agent"),
    sessionsRoot: join(root, "sessions"),
    env,
    onEvent: (event) => events.push(event),
  });
  const executor = attachExecutor(client, {
    mode: "in-process",
    agentDir: join(root, "agent"),
    sessionsRoot: join(root, "sessions"),
    env,
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

  it("resumeThread wakes a parked thread and rejects double open", async () => {
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

  it("per-sendId settled: concurrent sends settle their own turns (I3/I17)", async () => {
    const w = await makeWorld();
    try {
      const started = await w.executor.startThread({ cwd: w.root, trusted: false });
      if (!started.ok) throw new Error(started.reason.message);
      const thread = started.value;
      const [r1, r2] = await Promise.all([
        thread.send("one", { sendId: "q1", timeoutMs: 30_000 }),
        thread.send("two", { sendId: "q2", timeoutMs: 30_000 }),
      ]);
      expect(r1.ok && r1.value.sendId).toBe("q1");
      expect(r2.ok && r2.value.sendId).toBe("q2");
      expect(r1.ok && r1.value.ok).toBe(true);
      expect(r2.ok && r2.value.ok).toBe(true);
      await thread.stop();
    } finally {
      await w.cleanup();
    }
  }, 60_000);

  it("abort settles the in-flight send with ok=false reason=aborted (I10)", async () => {
    const w = await makeWorld(makeEnv([{ delayMs: 4000 }, { reply: "after" }]));
    try {
      const started = await w.executor.startThread({ cwd: w.root, trusted: false });
      if (!started.ok) throw new Error(started.reason.message);
      const thread = started.value;
      const inflight = thread.send("slow", { sendId: "q1", timeoutMs: 30_000 });
      setTimeout(() => {
        void thread.abort("client-abort");
      }, 300);
      const report = await inflight;
      expect(report.ok && report.value.ok).toBe(false);
      if (report.ok && !report.value.ok) expect(report.value.reason).toBe("aborted");
      const after = await thread.send("next", { timeoutMs: 30_000 });
      expect(after.ok && after.value.ok).toBe(true);
      await thread.stop();
    } finally {
      await w.cleanup();
    }
  }, 60_000);

  it("retire keeps parked sessionPath and frees occupancy (I2/I12)", async () => {
    const w = await makeWorld(makeEnv([{ delayMs: 4000 }, { reply: "x" }]));
    try {
      const started = await w.executor.startThread({ cwd: w.root, trusted: false });
      if (!started.ok) throw new Error(started.reason.message);
      const thread = started.value;
      const inflight = thread.send("slow", { timeoutMs: 30_000 });
      setTimeout(() => {
        void thread.abort();
      }, 200);
      await inflight;
      const retire = await thread.retire();
      expect(retire.ok).toBe(true);
      const parked = w.client.internal.table.get(thread.threadId);
      expect(parked?.state).toBe("parked");
      expect(parked?.sessionPath).toContain("events.jsonl");
      const holder = w.client.internal.table.holderOf(parked?.sessionPath ?? "");
      expect(holder).toBeUndefined();
      await thread.stop();
    } finally {
      await w.cleanup();
    }
  }, 60_000);

  it("divergent verdicts settle per-sendId on the event stream (I3)", async () => {
    const w = await makeWorld(makeEnv([{ reply: "turn1-ok" }, { delayMs: 60000 }]));
    try {
      const started = await w.executor.startThread({ cwd: w.root, trusted: false });
      if (!started.ok) throw new Error(started.reason.message);
      const thread = started.value;
      const r1 = await thread.send("one", { sendId: "q1", timeoutMs: 30_000 });
      expect(r1.ok && r1.value.ok).toBe(true);
      const inflight = thread.send("two", { sendId: "q2", timeoutMs: 30_000 });
      setTimeout(() => {
        void thread.abort("mid");
      }, 300);
      const r2 = await inflight;
      expect(r2.ok && r2.value.ok).toBe(false);
      if (r2.ok && !r2.value.ok) expect(r2.value.reason).toBe("aborted");
      const settledFrames = w.events.filter((e) => e.kind === "settled").map((e) => (e.kind === "settled" ? { sendId: e.sendId, ok: e.ok } : null));
      const q1Frame = settledFrames.find((f) => f?.sendId === "q1");
      const q2Frame = settledFrames.find((f) => f?.sendId === "q2");
      expect(q1Frame?.ok).toBe(true);
      expect(q2Frame?.ok).toBe(false);
      await thread.stop();
    } finally {
      await w.cleanup();
    }
  }, 60_000);

  it("timeoutMs arms the waiter timer (R2)", async () => {
    const w = await makeWorld(makeEnv([{ delayMs: 600000 }]));
    try {
      const started = await w.executor.startThread({ cwd: w.root, trusted: false });
      if (!started.ok) throw new Error(started.reason.message);
      const thread = started.value;
      const report = await thread.send("hang", { timeoutMs: 250 });
      expect(report.ok && report.value.ok).toBe(false);
      if (report.ok && !report.value.ok) expect(report.value.reason).toBe("timeout");
      await thread.abort();
      await thread.stop();
    } finally {
      await w.cleanup();
    }
  }, 60_000);

  it("chained-turn attribution: queued send settles on its own turn (I17)", async () => {
    const w = await makeWorld(makeEnv([{ delayMs: 400 }, { reply: "turn1-ok" }, { delayMs: 5000 }]));
    try {
      const started = await w.executor.startThread({ cwd: w.root, trusted: false });
      if (!started.ok) throw new Error(started.reason.message);
      const thread = started.value;
      const aP = thread.send("A", { sendId: "A", timeoutMs: 30_000 });
      setTimeout(() => {
        void thread.send("B", { sendId: "B", timeoutMs: 30_000 });
      }, 120);
      setTimeout(() => {
        void thread.abort("mid");
      }, 800);
      const ra = await aP;
      expect(ra.ok && ra.value.ok).toBe(true);
      const bSeen = (): boolean => w.events.some((e) => e.kind === "settled" && e.sendId === "B");
      await waitFor(bSeen, 20_000);
      const aFrame = w.events.find((e) => e.kind === "settled" && e.sendId === "A");
      const bFrame = w.events.find((e) => e.kind === "settled" && e.sendId === "B");
      expect(aFrame?.kind === "settled" && aFrame.ok).toBe(true);
      expect(bFrame?.kind === "settled" && bFrame.ok).toBe(false);
      if (bFrame?.kind === "settled") expect(bFrame.reason).toBe("aborted");
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

  it("thread limit rejects startThread beyond maxThreads", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-limit-"));
    try {
      const env = makeEnv([{ reply: "x" }, { reply: "y" }]);
      const client = createSdkClient({
        mode: "in-process",
        agentDir: join(root, "agent"),
        sessionsRoot: join(root, "sessions"),
        env,
        limits: { maxThreads: 1 },
        onEvent: () => {},
      });
      const executor = attachExecutor(client, { mode: "in-process", agentDir: join(root, "agent"), sessionsRoot: join(root, "sessions"), env });
      const first = await executor.startThread({ cwd: root, trusted: false });
      expect(first.ok).toBe(true);
      const second = await executor.startThread({ cwd: root, trusted: false });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason.code).toBe("thread_limit");
      if (first.ok) await first.value.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
