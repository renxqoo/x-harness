import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setThinkingLevel, getThinkingLevel } from "../commands/meta.ts";
import type { MetaCommandState } from "../commands/meta.ts";
import { getMessages, getState, getEntries, withinResponseBudget } from "../commands/read.ts";
import type { ReadCommandState } from "../commands/read.ts";
import { outcomeLine, unknownCommandLine } from "../commands/worker-adapter.ts";
import { startInprocess } from "../executor-inprocess/run.ts";
import { createScriptAdapter } from "../script-adapter.ts";
import type { AssemblySpec } from "../executor-inprocess/assembly.ts";
import type { SdkEvent } from "../events.ts";

async function makeRun(script: unknown[] = [{ reply: "hello" }]) {
  const root = await mkdtemp(join(tmpdir(), "sdk-cmd-"));
  const events: SdkEvent[] = [];
  const run = await startInprocess({
    threadId: "probe",
    spec: {
      cwd: root,
      trusted: false,
      sessionsRoot: join(root, "sessions"),
      agentDir: join(root, "agent"),
      mailboxRoot: join(root, "mailbox"),
      workflowRoot: join(root, "workflow"),
      skillsDirs: [],
      rgBinDir: join(root, "bin"),
      adapters: [createScriptAdapter(script as never)],
      agentOptions: { provider: "script", model: "script-1" },
      persistence: "durable",
      mainSessionId: (await import("@x-harness/session")).mintSessionId(),
      env: {},
      onWarn: () => {},
    } satisfies AssemblySpec,
  });
  void run.onEvent((event) => events.push(event));
  return { root, run, events, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("dual-host command contracts", () => {
  it("read commands resolve outcomes against a live in-process session", async () => {
    const w = await makeRun();
    try {
      const session = w.run.handle.agent.session;
      w.run.handle.agent.followup("hello");
      await w.run.handle.agent.whenIdle();
      const state: ReadCommandState = {
        session,
        threadId: String(session.id),
        sessionsRoot: join(w.root, "sessions"),
        skillsDirs: [],
        skillsDisabled: new Set(),
        commands: undefined,
        world: undefined,
        delegation: undefined,
        broker: { pendingAll: () => [] },
        inflightState: { snapshot: () => ({}) },
        bash: { readLatest: () => undefined },
        bridge: { isStreaming: () => false, commandBusy: () => false },
        dial: { provider: "script", model: "script-1" },
      };
      const state2 = getState(state);
      expect(state2.error).toBeUndefined();
      if (state2.data !== undefined) {
        const payload = state2.data as { messageCount: number; sessionId: string };
        expect(payload.messageCount).toBeGreaterThanOrEqual(1);
        expect(payload.sessionId).toBe(String(session.id));
      }
      const msgs = getMessages(state);
      expect(msgs.error).toBeUndefined();
      const entries = getEntries(state, {});
      expect(entries.error).toBeUndefined();
      expect(withinResponseBudget([{ a: 1 }], 8192)).toBe(true);
      expect(withinResponseBudget([bigPayload(9000)], 8192)).toBe(false);
    } finally {
      await w.run.dispose();
      await w.cleanup();
    }
  });

  it("meta commands validate input without a live session", async () => {
    const state: MetaCommandState = {
      session: undefined,
      threadId: "",
      agentDir: "/tmp/x",
      cwd: "/tmp/x",
      trusted: false,
      catalog: { providers: [], default: { provider: "", model: "" }, modelMeta: {} },
      dial: { provider: "", model: "" },
      thinkingFallback: undefined,
      permissionModeSource: undefined,
      world: undefined,
      permissionService: undefined,
      streaming: () => false,
    };
    const level = await setThinkingLevel(state, "high");
    expect(level.error?.code).toBe("unknown_thread");
    const invalid = await setThinkingLevel({ ...state, session: fakeSession() }, "bogus");
    expect(invalid.error?.code).toBe("invalid_input");
    const get = getThinkingLevel(state);
    expect(get.error?.code).toBe("unknown_thread");
  });

  it("outcomeLine serializes byte-identical to responseFrame contract", () => {
    const line = outcomeLine({ command: "get_state", data: { a: 1 } }, "q1");
    expect(line).toBe('{"id":"q1","type":"response","command":"get_state","success":true,"data":{"a":1}}');
    const noId = outcomeLine({ command: "compact" }, undefined);
    expect(noId).toBe('{"id":null,"type":"response","command":"compact","success":true}');
    const errLine = outcomeLine({ command: "prompt", error: { code: "invalid_input", message: "bad" } }, "q2");
    expect(errLine).toBe('{"id":"q2","type":"response","command":"prompt","success":false,"error":{"code":"invalid_input","message":"bad"}}');
    const unknown = unknownCommandLine("nope", "q3");
    expect(unknown).toBe('{"id":"q3","type":"response","command":"nope","success":false,"error":{"code":"unknown_command","message":"unknown command"}}');
  });
});

function bigPayload(size: number): unknown {
  return { blob: "x".repeat(size) };
}

function fakeSession(): never {
  return {
    events: () => [{ seq: 0, time: 0, type: "turn/end", data: { reason: { kind: "completed" } } }],
    append: () => ({ ok: true }),
    id: "fake",
  } as never;
}
