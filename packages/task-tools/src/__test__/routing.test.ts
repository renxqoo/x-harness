// 三态路由测试（docs/TASKS.md §1.1/§1.2 + docs/TASK-PUSH-DESIGN.md §2.1）：denied 终结
// 透传/全 miss 统一词表/迟到 miss 回落/单源异常隔离/入口前置校验。经 ToolDefinition.execute
// 直调（schema 校验属 registry 面，plugin.test 覆盖）。

import { describe, expect, it } from "vitest";
import type { SessionId } from "@x-harness/session";
import { createTaskHub } from "../hub.ts";
import { createTaskTools, notFoundText } from "../tools.ts";
import type { TaskProbe, TaskSource } from "../tokens.ts";

const sid = (v: string): SessionId => v as SessionId;
const CALLER = sid("caller-1");

interface SourcePlan {
  readonly kind: "agent" | "bash";
  readonly probe: TaskProbe;
  readonly stopText?: string;
  readonly stopReason?: string;
  readonly throwProbe?: boolean;
  readonly throwStop?: boolean;
}

/** 记录型 stub 源：probe/stop 计数（state 引用直读——闭包自增对外可见） */
function stubSource(plan: SourcePlan): { source: TaskSource; state: { probes: number; stops: number } } {
  const state = { probes: 0, stops: 0 };
  return {
    source: {
      kind: plan.kind,
      probe: () => {
        state.probes += 1;
        if (plan.throwProbe) throw new Error("probe-bug");
        return plan.probe;
      },
      stop: (taskId) => {
        void taskId;
        state.stops += 1;
        if (plan.throwStop) return Promise.reject(new Error("stop-bug"));
        if (plan.stopReason !== undefined) return Promise.resolve({ ok: false, reason: plan.stopReason });
        return Promise.resolve({ ok: true, text: plan.stopText ?? `${plan.kind}-stopped` });
      },
    },
    state,
  };
}

function face(sources: readonly TaskSource[], onWarn?: (message: string) => void) {
  const hub = createTaskHub();
  for (const source of sources) hub.registerSource(source);
  const [stopTool] = createTaskTools(hub, onWarn);
  if (stopTool === undefined) throw new Error("tool missing");
  const exec = (args: unknown, session: SessionId | undefined) =>
    stopTool.execute(args, { callId: "c1", name: stopTool.name, signal: new AbortController().signal, ...(session !== undefined ? { session } : {}) });
  return {
    stop: (args: unknown) => exec(args, CALLER),
    stopNoSession: (args: unknown) => exec(args, undefined),
  };
}

describe("task_stop routing", () => {
  it("reaches the claiming source's stop", async () => {
    const bash = stubSource({ kind: "bash", probe: { kind: "hit" } });
    const world = face([stubSource({ kind: "agent", probe: { kind: "miss" } }).source, bash.source]);
    const out = await world.stop({ task_id: "t-ab12cd34ef56" });
    expect(out).toEqual({ content: "bash-stopped" });
    expect(bash.state.stops).toBe(1);
  });

  it("denied terminates and passes the source wording through verbatim — a later claiming source must not shadow it", async () => {
    const agent = stubSource({ kind: "agent", probe: { kind: "denied", reason: "not-owner:agent-ab12cd34; you can only stop/message sub-agents you spawned" } });
    const bash = stubSource({ kind: "bash", probe: { kind: "hit" } });
    const world = face([agent.source, bash.source]);
    const out = await world.stop({ task_id: "agent-ab12cd34" });
    expect(out).toEqual({ content: "not-owner:agent-ab12cd34; you can only stop/message sub-agents you spawned", isError: true });
    expect(bash.state.probes).toBe(0); // denied 不续走
  });

  it("all miss falls to the unified not-found wording", async () => {
    const world = face([stubSource({ kind: "agent", probe: { kind: "miss" } }).source, stubSource({ kind: "bash", probe: { kind: "miss" } }).source]);
    const out = await world.stop({ task_id: "nope" });
    expect(out).toEqual({ content: notFoundText("nope"), isError: true });
    expect(notFoundText("nope")).toContain("bash ids come from bash run_in_background");
  });

  it("late not-found from a claimed source (archive/evict race) falls back to the unified wording", async () => {
    const agent = stubSource({ kind: "agent", probe: { kind: "hit" }, stopReason: "not-found:agent-ab12cd34; use list_agents to see your sub-agents" });
    const world = face([agent.source, stubSource({ kind: "bash", probe: { kind: "miss" } }).source]);
    const out = await world.stop({ task_id: "agent-ab12cd34" });
    expect(out).toEqual({ content: notFoundText("agent-ab12cd34"), isError: true });
  });

  it("a throwing probe is isolated with a warning and routing continues", async () => {
    const warnings: string[] = [];
    const agent = stubSource({ kind: "agent", probe: { kind: "hit" }, throwProbe: true });
    const bash = stubSource({ kind: "bash", probe: { kind: "hit" }, stopText: "bash-stopped" });
    const world = face([agent.source, bash.source], (message) => warnings.push(message));
    const out = await world.stop({ task_id: "shared-id" });
    expect(out).toEqual({ content: "bash-stopped" });
    expect(warnings.some((message) => message.includes("probe threw"))).toBe(true);
  });

  it("a throwing stop counts as miss with a trace — one source's bug cannot pierce another", async () => {
    const warnings: string[] = [];
    const agent = stubSource({ kind: "agent", probe: { kind: "hit" }, throwStop: true });
    const bash = stubSource({ kind: "bash", probe: { kind: "hit" }, stopText: "bash-stopped" });
    const world = face([agent.source, bash.source], (message) => warnings.push(message));
    const out = await world.stop({ task_id: "shared-id" });
    expect(out).toEqual({ content: "bash-stopped" });
    expect(warnings.some((message) => message.includes("source 'agent' threw"))).toBe(true);
  });
});

describe("task tool entry prechecks (not routed)", () => {
  const hit = (): TaskSource => stubSource({ kind: "agent", probe: { kind: "hit" } }).source;

  it("rejects empty task_id", async () => {
    const world = face([hit()]);
    expect(await world.stop({ task_id: "" })).toEqual({ content: "invalid-args:task_id must be a non-empty string", isError: true });
  });

  it("rejects task_id containing a newline", async () => {
    const world = face([hit()]);
    const out = await world.stop({ task_id: "agent-ab12cd34\nx" });
    expect(out.content).toContain("must not contain newlines");
  });

  it("rejects callers without a session", async () => {
    const world = face([hit()]);
    const out = await world.stopNoSession({ task_id: "agent-ab12cd34" });
    expect(out).toEqual({ content: "invalid-args:task tools are only available inside an agent session", isError: true });
  });

  it("rejects task_id 'main' with the denied-style termination", async () => {
    const world = face([hit()]);
    expect(await world.stop({ task_id: "main" })).toEqual({ content: "invalid-args:task_id 'main' is not a task", isError: true });
  });
});
