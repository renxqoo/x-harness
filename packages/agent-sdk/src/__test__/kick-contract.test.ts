import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintSessionId } from "@x-harness/session";
import { startInprocess } from "../executor-inprocess/run.ts";
import { createScriptAdapter } from "../shared/script-adapter.ts";
import type { AssemblySpec } from "../executor-inprocess/assembly.ts";

async function makeRun(script: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "sdk-kick-"));
  const run = await startInprocess({
    threadId: "kick",
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

describe("kick 同步前缀契约（B.P1-1：同 tick 双 followup 锚定依赖）", () => {
  it("followup 返回后 turn/start 已同步可见（驱动器在首个 await 前落 turn/start）", async () => {
    const w = await makeRun([{ reply: "a" }, { reply: "b" }]);
    try {
      const agent = w.run.handle.agent;
      const before = agent.session.events().length;
      agent.followup("first");
      const events = agent.session.events();
      const starts = events.filter((event) => event.type === "turn/start");
      expect(starts.length).toBeGreaterThanOrEqual(1);
      expect(events.length).toBeGreaterThan(before);
      await agent.whenIdle();
    } finally {
      await w.run.dispose();
      await w.cleanup();
    }
  }, 30_000);

  it("同 tick 第二个 followup 能观测到第一个的 turn/start（锚定不重叠）", async () => {
    const w = await makeRun([{ reply: "a" }, { reply: "b" }]);
    try {
      const agent = w.run.handle.agent;
      agent.followup("first");
      const startsAtSecondKick = agent.session.events().filter((event) => event.type === "turn/start").length;
      agent.followup("second");
      const startsAfter = agent.session.events().filter((event) => event.type === "turn/start").length;
      expect(startsAtSecondKick).toBe(1);
      expect(startsAfter).toBe(1);
      await agent.whenIdle();
    } finally {
      await w.run.dispose();
      await w.cleanup();
    }
  }, 30_000);
});
