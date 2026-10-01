import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadNotify, threadStop, forkInputVerdict } from "../commands/lifecycle.ts";
import { mintSessionId } from "@x-harness/session";
import { startInprocess } from "../executor-inprocess/run.ts";
import { createScriptAdapter } from "../shared/script-adapter.ts";
import type { AssemblySpec } from "../executor-inprocess/assembly.ts";

describe("lifecycle command contracts", () => {
  it("thread/notify validates inputs and routes by agent status", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-lc-"));
    const run = await startInprocess({
      threadId: "lc",
      spec: fakeSpec(root),
    });
    try {
      const agent = run.handle.agent;
      const state = { session: agent.session, agent, stopAll: async () => {} };
      const bad = threadNotify(state, { source: "", kind: "directive", text: "x" });
      expect(bad.error?.code).toBe("invalid_input");
      const okIdle = threadNotify(state, { source: "ci", kind: "directive", text: "look" });
      expect(okIdle.error).toBeUndefined();
      const stopped = await threadStop(state);
      expect(stopped.error).toBeUndefined();
      expect(stopped.control?.kind).toBe("thread-stopped");
    } finally {
      await run.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fork verdict enforces the durable boundary", () => {
    expect(forkInputVerdict(10, { seq: 3, position: "at" }, true)?.error?.code).toBe("streaming_window");
    expect(forkInputVerdict(10, { seq: -1 }, false)?.error?.code).toBe("invalid_input");
    expect(forkInputVerdict(10, { seq: 11 }, false)?.error?.code).toBe("cursor_stale");
    expect(forkInputVerdict(10, { seq: 0, position: "before" }, false)?.error?.code).toBe("invalid_input");
    expect(forkInputVerdict(10, { seq: 0, position: "at" }, false)).toBeUndefined();
  });
});

function fakeSpec(root: string): AssemblySpec {
  return {
    cwd: root,
    trusted: false,
    sessionsRoot: join(root, "sessions"),
    agentDir: join(root, "agent"),
    mailboxRoot: join(root, "mailbox"),
    workflowRoot: join(root, "workflow"),
    skillsDirs: [],
    rgBinDir: join(root, "bin"),
    adapters: [createScriptAdapter([{ reply: "ok" }])],
    agentOptions: { provider: "script", model: "script-1" },
    persistence: "durable",
    mainSessionId: mintSessionId(),
    env: {},
    onWarn: () => {},
  };
}
