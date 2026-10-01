import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintSessionId } from "@x-harness/session";
import { startInprocess } from "../executor-inprocess/run.ts";
import { createScriptAdapter } from "../shared/script-adapter.ts";
import type { AssemblySpec } from "../executor-inprocess/assembly.ts";
import { setPermissionMode, permissionGrant, permissionListRules, permissionRemoveRule } from "../commands/meta.ts";
import type { MetaCommandState } from "../commands/meta.ts";

const RULE_CASES: ReadonlyArray<{ rule: string; scope: "session" | "project" | "user"; accept: string }> = [
  { rule: "Danger(ls:*):allow", scope: "session", accept: "granted" },
  { rule: "Danger(npm install:*):allow", scope: "project", accept: "granted" },
  { rule: "Danger(*:*):allow", scope: "session", accept: "invalid" },
  { rule: "Danger(rm:*):deny", scope: "session", accept: "invalid" },
  { rule: "Danger(broken", scope: "user", accept: "invalid" },
  { rule: "Danger(memory):allow", scope: "session", accept: "invalid-or-internal" },
  { rule: "Read(*):allow", scope: "session", accept: "invalid-or-internal" },
];

async function makeRun() {
  const root = await mkdtemp(join(tmpdir(), "sdk-perm-"));
  const run = await startInprocess({
    threadId: "perm",
    spec: {
      cwd: root, trusted: true,
      sessionsRoot: join(root, "sessions"), agentDir: join(root, "agent"),
      mailboxRoot: join(root, "mailbox"), workflowRoot: join(root, "workflow"),
      skillsDirs: [], rgBinDir: join(root, "bin"),
      adapters: [createScriptAdapter([{ reply: "ok" }])],
      agentOptions: { provider: "script", model: "script-1" },
      persistence: "durable", mainSessionId: mintSessionId(), env: {}, onWarn: () => {},
    } satisfies AssemblySpec,
  });
  return { root, run, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function metaState(run: Awaited<ReturnType<typeof makeRun>>["run"]): MetaCommandState {
  const agent = run.handle.agent;
  return {
    session: agent.session, threadId: String(agent.session.id),
    agentDir: "/tmp/x", cwd: "/tmp", trusted: true,
    catalog: { providers: [], default: { provider: "", model: "" }, modelMeta: {} },
    dial: { provider: "script", model: "script-1" },
    thinkingFallback: undefined, permissionModeSource: undefined,
    world: undefined, permissionService: { set: () => {}, get: () => undefined },
    streaming: () => false,
  };
}

describe("permission 域表驱动（A14）", () => {
  it.each(RULE_CASES)("规则 $rule @ $scope → $accept", async (testCase) => {
    const w = await makeRun();
    try {
      const state = metaState(w.run);
      const outcome = await permissionGrant(state, { rule: testCase.rule, scope: testCase.scope });
      if (testCase.accept === "granted") {
        expect(outcome.error === undefined || outcome.error.code === "internal").toBe(true);
        const listed = await permissionListRules(state);
        expect(listed.error).toBeUndefined();
      } else if (testCase.accept === "invalid-or-internal") {
        expect(["invalid_input", "internal"]).toContain(outcome.error?.code);
      } else {
        expect(outcome.error?.code).toBe("invalid_input");
      }
    } finally {
      await w.run.dispose();
      await w.cleanup();
    }
  }, 30_000);

  it("set_mode 表驱动：合法模式/自定义/垃圾", async () => {
    const w = await makeRun();
    try {
      const state = metaState(w.run);
      for (const [mode, expected] of [["auto", true], ["plan", true], ["sandboxed-auto", true], ["nope", false]] as const) {
        const outcome = await setPermissionMode(state, mode);
        expect(outcome.error === undefined).toBe(expected);
      }
    } finally {
      await w.run.dispose();
      await w.cleanup();
    }
  }, 30_000);

  it("remove_rule 表驱动：session 拒/untrusted project 拒/垃圾 scope 拒", async () => {
    const w = await makeRun();
    try {
      const state = metaState(w.run);
      const sessionScope = await permissionRemoveRule(state, { scope: "session", tool: "Danger", pattern: "x:*" });
      expect(sessionScope.error?.code).toBe("invalid_input");
      const badScope = await permissionRemoveRule(state, { scope: "wrong", tool: "x", pattern: "y" });
      expect(badScope.error?.code).toBe("invalid_input");
    } finally {
      await w.run.dispose();
      await w.cleanup();
    }
  });
});
