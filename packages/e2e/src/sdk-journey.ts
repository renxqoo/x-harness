import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkClient } from "@x-harness/agent-sdk";
import { attachExecutor } from "@x-harness/agent-sdk";
import type { SdkEvent } from "@x-harness/agent-sdk";
import { must as check } from "./check.ts";

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
    check("startThread ok", started.ok);
    if (!started.ok) throw new Error(started.reason.message);
    const thread = started.value;
    const threadId = thread.threadId;

    const first = await thread.send("hello", { sendId: "j1", timeoutMs: 30_000 });
    check("send settles ok", first.ok && first.value.ok === true);
    check("sendId round-trips", first.ok && first.value.sendId === "j1");

    const settledFrames = events.filter((e) => e.kind === "settled" && e.sendId === "j1");
    check("per-sendId settled frame observed", settledFrames.length === 1);
    const streamFrames = events.filter((e) => e.kind === "stream");
    check("stream frames flow", streamFrames.length > 0);
    const sessionFrames = events.filter((e) => e.kind === "session");
    check("session frames carry owner", sessionFrames.length > 0 && sessionFrames.every((e) => e.kind === "session" && e.owner === threadId));

    const retire = await thread.retire();
    check("retire ok", retire.ok);
    check("retire parks thread", client.internal.table.get(threadId)?.state === "parked");

    const resumed = await executor.resumeThread({ threadId, cwd: root });
    check("resume wakes parked thread", resumed.ok);
    if (resumed.ok) {
      const after = await resumed.value.send("again", { sendId: "j2", timeoutMs: 30_000 });
      check("send after resume settles ok", after.ok && after.value.ok === true);
      await resumed.value.stop();
    }
    check("stop removes thread", client.internal.table.get(threadId) === undefined);
    console.log("sdk-journey: all checks passed");
  } finally {
    await executor.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
}

await main();
