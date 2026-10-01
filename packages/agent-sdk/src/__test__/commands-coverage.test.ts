import { describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintSessionId } from "@x-harness/session";
import { startInprocess } from "../executor-inprocess/run.ts";
import { createScriptAdapter } from "../script-adapter.ts";
import type { AssemblySpec } from "../executor-inprocess/assembly.ts";
import { setThinkingLevel, getThinkingLevel, setPermissionMode, getPermissionMode, permissionGrant, permissionListRules, permissionRemoveRule } from "../commands/meta.ts";
import type { MetaCommandState } from "../commands/meta.ts";
import { getMessages, getEntries, getTree, getSessionStats, setSessionName, getCommands, getForkMessages, getSubagents, getPendingDialogs, getPlugins, getInflight, withinResponseBudget } from "../commands/read.ts";
import type { ReadCommandState } from "../commands/read.ts";
import { workflowSubmit, workflowStop } from "../commands/workflow.ts";
import type { WorkflowCommandState } from "../commands/workflow.ts";
import { steer, followUp } from "../commands/send.ts";
import type { SendCommandState } from "../commands/send.ts";
import { bashOutcomeError } from "../commands/send.ts";

async function makeRun(script: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "sdk-cov-"));
  const run = await startInprocess({
    threadId: "cov",
    spec: {
      cwd: root, trusted: true,
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

function hugePayload(): unknown {
  return { blob: "x".repeat(100 * 1024 * 1024) };
}

function sendStateOf(run: Awaited<ReturnType<typeof makeRun>>["run"], over: Partial<SendCommandState> = {}): SendCommandState {
  const agent = run.handle.agent;
  return {
    session: agent.session, currentThreadId: String(agent.session.id),
    catalog: { providers: [], default: { provider: "", model: "" }, modelMeta: {} },
    dial: { provider: "script", model: "script-1" }, commands: undefined, agent,
    streaming: () => false, pendingSends: () => 0,
    bash: { abortAdmissions: () => {}, abortRunning: () => {} },
    broker: { denyAll: () => {} },
    inflight: { abortAll: async () => {}, register: () => ({ signal: new AbortController().signal, unregister: () => {} }) },
    delegation: undefined, settle: () => {}, ...over,
  };
}

function readStateOf(run: Awaited<ReturnType<typeof makeRun>>["run"], over: Partial<ReadCommandState> = {}): ReadCommandState {
  const session = run.handle.agent.session;
  return {
    session, threadId: String(session.id), sessionsRoot: run.world ? "" : "",
    skillsDirs: [], skillsDisabled: new Set(), commands: undefined,
    world: undefined, delegation: undefined,
    broker: { pendingAll: () => [] },
    inflightState: { snapshot: () => ({ tools: [] }) },
    bash: { readLatest: () => undefined },
    bridge: { isStreaming: () => false, commandBusy: () => false },
    dial: { provider: "script", model: "script-1" }, ...over,
  } as ReadCommandState;
}

function metaStateOf(run: Awaited<ReturnType<typeof makeRun>>["run"], over: Partial<MetaCommandState> = {}): MetaCommandState {
  const agent = run.handle.agent;
  return {
    session: agent.session, threadId: String(agent.session.id),
    agentDir: "/tmp/agent", cwd: "/tmp", trusted: false,
    catalog: { providers: [{ provider: "script", protocol: "anthropic", baseUrl: "x", apiKey: "k", models: ["script-1"], contextWindow: 1000 }], default: { provider: "script", model: "script-1" }, modelMeta: {} },
    dial: { provider: "script", model: "script-1" },
    thinkingFallback: undefined, permissionModeSource: undefined,
    world: undefined, permissionService: { set: () => {}, get: () => undefined },
    streaming: () => false, ...over,
  };
}

describe("commands 域覆盖率补齐（meta/read/workflow/send）", () => {
  it("meta 域：thinking/permission 全命令族对真实 session", async () => {
    const w = await makeRun([{ reply: "ok" }, { reply: "ok2" }]);
    try {
      const agent = w.run.handle.agent;
      agent.followup("hello");
      await agent.whenIdle();
      const state = metaStateOf(w.run);
      const before = getThinkingLevel(state);
      expect(before.error).toBeUndefined();
      const set = await setThinkingLevel(state, "high");
      expect(set.error).toBeUndefined();
      const after = getThinkingLevel(state);
      expect(after.error).toBeUndefined();
      const invalid = await setThinkingLevel(state, "bogus");
      expect(invalid.error?.code).toBe("invalid_input");
      const busy = await setThinkingLevel(metaStateOf(w.run, { streaming: () => true }), "high");
      expect(busy.error?.code).toBe("streaming_window");

      const modeSet = await setPermissionMode(state, "plan");
      expect(modeSet.error).toBeUndefined();
      const modeGet = getPermissionMode(state);
      expect(modeGet.error).toBeUndefined();
      const modeBad = await setPermissionMode(state, "nope");
      expect(modeBad.error?.code).toBe("invalid_input");

      const grantBad = await permissionGrant(state, { rule: "not a rule" });
      expect(grantBad.error?.code).toBe("invalid_input");
      const sessionGrant = await permissionGrant(state, { rule: "Danger(ls:*):allow", scope: "session" });
      expect(sessionGrant.error?.code).toBe("internal");
      const listed = await permissionListRules(state);
      expect(listed.error).toBeUndefined();
      const removeSession = await permissionRemoveRule(state, { scope: "session", tool: "Danger", pattern: "ls:*" });
      expect(removeSession.error?.code).toBe("invalid_input");
      const removeBadScope = await permissionRemoveRule(state, { scope: "wrong", tool: "x", pattern: "y" });
      expect(removeBadScope.error?.code).toBe("invalid_input");
      const removeProjectUntrusted = await permissionRemoveRule(state, { scope: "project", tool: "Danger", pattern: "x:*" });
      expect(removeProjectUntrusted.error?.code).toBe("invalid_input");
    } finally {
      await w.run.dispose();
      await w.cleanup();
    }
  }, 30_000);

  it("read 域：全查询命令族", async () => {
    const w = await makeRun([{ reply: "some long answer text here" }]);
    try {
      const agent = w.run.handle.agent;
      agent.followup("hello");
      await agent.whenIdle();
      const state = readStateOf(w.run);
      expect(getInflight(state).error).toBeUndefined();
      const msgs = getMessages(state);
      expect(msgs.error).toBeUndefined();
      const entries = getEntries(state, { since: 0, limit: 5 });
      expect(entries.error).toBeUndefined();
      const badEntries = getEntries(state, { since: -5 });
      expect(badEntries.error?.code).toBe("cursor_stale");
      const badLimit = getEntries(state, { limit: -1 });
      expect(badLimit.error?.code).toBe("invalid_input");
      const tree = await getTree(state);
      expect(tree.error).toBeUndefined();
      const stats = getSessionStats(state);
      expect(stats.error).toBeUndefined();
      const named = await setSessionName(state, { name: "cov-run" });
      expect(named.error).toBeUndefined();
      const badName = await setSessionName(state, { name: " " });
      expect(badName.error?.code).toBe("invalid_input");
      const cmds = await getCommands(state);
      expect(cmds.error).toBeUndefined();
      const fork = getForkMessages(state);
      expect(fork.error).toBeUndefined();
      const subs = await getSubagents(state);
      expect(subs.error).toBeUndefined();
      const dialogs = getPendingDialogs(state);
      expect(dialogs.error).toBeUndefined();
      const plugins = getPlugins(state);
      expect(plugins.error).toBeUndefined();
      expect(withinResponseBudget([{}], 200_000_000)).toBe(true);
      expect(withinResponseBudget([hugePayload()], 100 * 1024 * 1024)).toBe(false);
    } finally {
      await w.run.dispose();
      await w.cleanup();
    }
  }, 30_000);

  it("workflow 域：submit/stop 校验族", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-wf-"));
    try {
      await mkdir(join(root, "runs", "r1"), { recursive: true });
      await writeFile(join(root, "runs", "r1", "journal.jsonl"), '{"type":"run/started"}\n', "utf8");
      const state: WorkflowCommandState = { session: undefined, env: {}, workflowRoot: root, world: undefined };
      const noSession = await workflowSubmit(state, {});
      expect(noSession.error?.code).toBe("unknown_thread");
      const badSchema = await workflowSubmit({ ...state, session: { id: "s1" } as never }, { resultSchema: "{bad json" });
      expect(badSchema.error?.code).toBe("invalid_input");
      const noView = await workflowSubmit({ ...state, session: { id: "s1" } as never }, {});
      expect(noView.error?.code).toBe("unknown_command");
      const stopNoTask = await workflowStop({ ...state, session: { id: "s1" } as never }, {});
      expect(stopNoTask.error?.code).toBe("invalid_input");
      const stopNoRegistry = await workflowStop({ ...state, session: { id: "s1" } as never }, { taskId: "t1" });
      expect(stopNoRegistry.error?.code).toBe("unknown_command");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("send 域：steer/followup/错误映射表", async () => {
    const w = await makeRun([{ reply: "a" }, { reply: "b" }]);
    try {
      const state = sendStateOf(w.run);
      const steered = await steer(state, { message: "inject" });
      expect(steered.error).toBeUndefined();
      await w.run.handle.agent.whenIdle();
      const queued = await followUp(state, { message: "next" });
      expect(queued.error).toBeUndefined();
      await w.run.handle.agent.whenIdle();
      const badImages = await steer(state, { message: "x", images: [{ base64: "", mediaType: "text/plain" }] });
      expect(badImages.error?.code).toBe("invalid_input");
      expect(bashOutcomeError("permission denied").code).toBe("bash_denied");
      expect(bashOutcomeError("concurrent direct bash requires a command id").code).toBe("invalid_input");
      expect(bashOutcomeError("bash command id is already in use").code).toBe("state_conflict");
      expect(bashOutcomeError("something else").code).toBe("internal");
    } finally {
      await w.run.dispose();
      await w.cleanup();
    }
  }, 30_000);
});
