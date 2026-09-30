import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkClient } from "@x-harness/agent-sdk";
import { attachExecutor } from "@x-harness/agent-sdk";
import type { SdkEvent } from "@x-harness/agent-sdk";
import { must } from "./check.ts";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "sdk-journey-"));
  const events: SdkEvent[] = [];
  const env = {
    HUB_WORKER_PROVIDER: "script",
    HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "journey-turn-1" }, { reply: "journey-turn-2" }, { reply: "journey-resumed" }]),
  };
  const client = createSdkClient({
    mode: "in-process",
    agentDir: join(root, "agent"),
    sessionsRoot: join(root, "sessions"),
    env,
    onEvent: (event) => events.push(event),
  });
  const executor = attachExecutor(client, { mode: "in-process", agentDir: join(root, "agent"), sessionsRoot: join(root, "sessions"), env });
  try {
    await client.startup();
    const started = await executor.startThread({ cwd: root, trusted: false });
    must(started.ok, "startThread ok");
    if (!started.ok) throw new Error(started.reason.message);
    const thread = started.value;
    const threadId = thread.threadId;

    const first = await thread.send("hello", { sendId: "j1", timeoutMs: 30_000 });
    must(first.ok && first.value.ok === true, "send settles ok");
    must(first.ok && first.value.sendId === "j1", "sendId round-trips");

    const settledFrames = events.filter((e) => e.kind === "settled" && e.sendId === "j1");
    must(settledFrames.length === 1, "per-sendId settled frame observed exactly once");
    const streamFrames = events.filter((e) => e.kind === "stream");
    must(streamFrames.length > 0, "stream frames flow");
    const sessionFrames = events.filter((e) => e.kind === "session");
    must(sessionFrames.length > 0 && sessionFrames.every((e) => e.kind === "session" && e.owner === threadId), "session frames carry owner");

    const empty = await thread.send("", { timeoutMs: 5_000 });
    must(!empty.ok && empty.reason.code === "invalid_input", "empty-text send rejected with invalid_input");

    const retire = await thread.retire();
    must(retire.ok, "retire ok");
    must(client.internal.table.get(threadId)?.state === "parked", "retire parks thread");

    const resumed = await executor.resumeThread({ threadId, cwd: root });
    must(resumed.ok, "resume wakes parked thread");
    if (resumed.ok) {
      const after = await resumed.value.send("again", { sendId: "j2", timeoutMs: 30_000 });
      must(after.ok && after.value.ok === true, "send after resume settles ok");
      await resumed.value.stop();
    }
    must(client.internal.table.get(threadId) === undefined, "stop removes thread");
    console.log("sdk-journey: all checks passed");
  } finally {
    await executor.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
}

await main();
