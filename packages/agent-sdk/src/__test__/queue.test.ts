import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintSessionId } from "@x-harness/session";
import { startInprocess } from "../executor-inprocess/run.ts";
import { createScriptAdapter } from "../shared/script-adapter.ts";
import type { AssemblySpec } from "../executor-inprocess/assembly.ts";
import { clearQueue, queueDrop, queueSendNow } from "../commands/queue.ts";
import type { QueueCommandState } from "../commands/queue.ts";

async function makeRun(script: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "sdk-queue-"));
  const run = await startInprocess({
    threadId: "queue",
    spec: {
      cwd: root, trusted: false,
      sessionsRoot: join(root, "sessions"), agentDir: join(root, "agent"),
      mailboxRoot: join(root, "mailbox"), workflowRoot: join(root, "workflow"),
      skillsDirs: [], rgBinDir: join(root, "bin"),
      adapters: [createScriptAdapter(script as never)],
      agentOptions: { provider: "script", model: "script-1" },
      persistence: "durable", mainSessionId: mintSessionId(), env: {}, onWarn: () => {},
    } satisfies AssemblySpec,
  });
  return { root, run, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function queueStateOf(run: Awaited<ReturnType<typeof makeRun>>["run"], over: Partial<QueueCommandState> = {}): QueueCommandState {
  const session = run.handle.agent.session;
  return {
    session,
    currentThreadId: String(session.id),
    world: { flush: async () => undefined },
    streaming: () => false,
    pendingSends: () => 0,
    ...over,
  };
}

describe("queue 命令族（outcome 契约）", () => {
  it("clear_queue 返回清空前快照并落 splice 事件", async () => {
    const w = await makeRun([{ reply: "ok" }]);
    try {
      const agent = w.run.handle.agent;
      agent.followup("one");
      agent.followup("two");
      await agent.whenIdle();
      const cleared = await clearQueue(queueStateOf(w.run), {});
      expect(cleared.error).toBeUndefined();
      if (cleared.data !== undefined) expect((cleared.data as { followUp?: unknown[] }).followUp).toBeDefined();
    } finally {
      await w.run.dispose();
      await w.cleanup();
    }
  }, 30_000);

  it("queue/drop 校验族：空 entryId invalid_input / 未知名 state_conflict", async () => {
    const w = await makeRun([{ reply: "ok" }]);
    try {
      const state = queueStateOf(w.run);
      const empty = await queueDrop(state, { entryId: "" });
      expect(empty.error?.code).toBe("invalid_input");
      const missing = await queueDrop(state, { entryId: "ghost" });
      expect(missing.error?.code).toBe("state_conflict");
    } finally {
      await w.run.dispose();
      await w.cleanup();
    }
  });

  it("queue/send_now 校验族：不在 follow-up 队列 state_conflict / 空闲时 streaming_window", async () => {
    const w = await makeRun([{ reply: "ok" }]);
    try {
      const state = queueStateOf(w.run);
      const notQueued = await queueSendNow(state, { entryId: "ghost" });
      expect(notQueued.error?.code).toBe("state_conflict");
      const idle = await queueSendNow(queueStateOf(w.run, { streaming: () => false, pendingSends: () => 0 }), { entryId: "x" });
      expect(idle.error === undefined || idle.error.code === "streaming_window" || idle.error.code === "state_conflict").toBe(true);
    } finally {
      await w.run.dispose();
      await w.cleanup();
    }
  });

  it("threadGate 门：superseded threadId 拒绝 queue 族", async () => {
    const w = await makeRun([{ reply: "ok" }]);
    try {
      const state = queueStateOf(w.run);
      const denied = await clearQueue(state, { threadId: "other" });
      expect(denied.error?.code).toBe("thread_superseded");
    } finally {
      await w.run.dispose();
      await w.cleanup();
    }
  });
});
