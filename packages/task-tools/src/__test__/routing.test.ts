// 三态路由测试（docs/TASKS.md §1.1/§1.2）：denied 终结透传/全 miss 统一词表/迟到 miss 回落/
// 单源异常隔离/block 归一化/入口前置校验。经 ToolDefinition.execute 直调（schema 校验属
// registry 面，plugin.test 覆盖）。

import { describe, expect, it } from "vitest";
import type { SessionId } from "@x-harness/session";
import { createTaskHub } from "../hub.ts";
import { createTaskTools, notFoundText } from "../tools.ts";
import type { TaskOutputOptions, TaskProbe, TaskSource } from "../tokens.ts";

const sid = (v: string): SessionId => v as SessionId;
const CALLER = sid("caller-1");

interface SourcePlan {
  readonly kind: "agent" | "bash";
  readonly probe: TaskProbe;
  readonly outputText?: string;
  readonly outputReason?: string;
  readonly throwProbe?: boolean;
  readonly throwOutput?: boolean;
}

/** 记录型 stub 源：probe/output 计数 + output 收到的 opts */
function stubSource(plan: SourcePlan): { source: TaskSource; probes: number; outputs: number; seenOpts: TaskOutputOptions[] } {
  const state = { probes: 0, outputs: 0, seenOpts: [] as TaskOutputOptions[] };
  return {
    source: {
      kind: plan.kind,
      probe: () => {
        state.probes += 1;
        if (plan.throwProbe) throw new Error("probe-bug");
        return plan.probe;
      },
      output: (taskId, _caller, opts) => {
        void taskId;
        state.outputs += 1;
        state.seenOpts.push(opts);
        if (plan.throwOutput) return Promise.reject(new Error("output-bug"));
        if (plan.outputReason !== undefined) return Promise.resolve({ ok: false, reason: plan.outputReason });
        return Promise.resolve({ ok: true, text: plan.outputText ?? `${plan.kind}-output` });
      },
      stop: () => Promise.resolve({ ok: true, text: `${plan.kind}-stopped` }),
    },
    ...state,
  };
}

function face(sources: readonly TaskSource[], onWarn?: (message: string) => void) {
  const hub = createTaskHub();
  for (const source of sources) hub.registerSource(source);
  const [outputTool, stopTool] = createTaskTools(hub, onWarn);
  if (outputTool === undefined || stopTool === undefined) throw new Error("tools missing");
  const exec = (tool: typeof outputTool, args: unknown, session: SessionId | undefined) =>
    tool.execute(args, { callId: "c1", name: tool.name, signal: new AbortController().signal, ...(session !== undefined ? { session } : {}) });
  return {
    output: (args: unknown) => exec(outputTool, args, CALLER),
    outputNoSession: (args: unknown) => exec(outputTool, args, undefined),
    stop: (args: unknown) => exec(stopTool, args, CALLER),
  };
}

describe("task_output routing", () => {
  it("hit source answers", async () => {
    const agent = stubSource({ kind: "agent", probe: { kind: "hit" }, outputText: "the report" });
    const world = face([agent.source]);
    const out = await world.output({ task_id: "agent-ab12cd34" });
    expect(out).toEqual({ content: "the report" });
  });

  it("denied terminates and passes the source wording through verbatim — a later claiming source must not shadow it", async () => {
    const agent = stubSource({ kind: "agent", probe: { kind: "denied", reason: "not-owner:agent-ab12cd34; you can only read/stop sub-agents you spawned" } });
    const bash = stubSource({ kind: "bash", probe: { kind: "hit" }, outputText: "bash-output" });
    const world = face([agent.source, bash.source]);
    const out = await world.output({ task_id: "agent-ab12cd34" });
    expect(out).toEqual({ content: "not-owner:agent-ab12cd34; you can only read/stop sub-agents you spawned", isError: true });
    expect(bash.probes).toBe(0); // denied 不续走
  });

  it("all miss falls to the unified not-found wording", async () => {
    const agent = stubSource({ kind: "agent", probe: { kind: "miss" } });
    const bash = stubSource({ kind: "bash", probe: { kind: "miss" } });
    const world = face([agent.source, bash.source]);
    const out = await world.output({ task_id: "nope" });
    expect(out).toEqual({ content: notFoundText("nope"), isError: true });
    expect(notFoundText("nope")).toContain("bash ids come from bash run_in_background");
  });

  it("late not-found from a claimed source (archive/evict race) falls back to the unified wording", async () => {
    const agent = stubSource({ kind: "agent", probe: { kind: "hit" }, outputReason: "not-found:agent-ab12cd34; use list_agents to see your sub-agents" });
    const bash = stubSource({ kind: "bash", probe: { kind: "miss" } });
    const world = face([agent.source, bash.source]);
    const out = await world.output({ task_id: "agent-ab12cd34" });
    expect(out).toEqual({ content: notFoundText("agent-ab12cd34"), isError: true });
  });

  it("a throwing probe counts as miss and leaves a trace — one source's bug cannot pierce another", async () => {
    const warnings: string[] = [];
    const agent = stubSource({ kind: "agent", probe: { kind: "hit" }, throwOutput: true });
    const bash = stubSource({ kind: "bash", probe: { kind: "miss" } });
    const world = face([agent.source, bash.source], (message) => warnings.push(message));
    const out = await world.output({ task_id: "agent-ab12cd34" });
    expect(out).toEqual({ content: notFoundText("agent-ab12cd34"), isError: true });
    expect(warnings.some((message) => message.includes("source 'agent' threw"))).toBe(true);
  });

  it("a throwing probe is isolated with a warning and routing continues", async () => {
    const warnings: string[] = [];
    const agent = stubSource({ kind: "agent", probe: { kind: "hit" }, throwProbe: true });
    const bash = stubSource({ kind: "bash", probe: { kind: "hit" }, outputText: "bash-output" });
    const world = face([agent.source, bash.source], (message) => warnings.push(message));
    const out = await world.output({ task_id: "shared-id" });
    expect(out).toEqual({ content: "bash-output" });
    expect(warnings.some((message) => message.includes("probe threw"))).toBe(true);
  });

  it("normalizes block at the tool layer: omitted arrives at the source as explicit true", async () => {
    const agent = stubSource({ kind: "agent", probe: { kind: "hit" } });
    const world = face([agent.source]);
    await world.output({ task_id: "agent-ab12cd34" });
    await world.output({ task_id: "agent-ab12cd34", block: false });
    await world.output({ task_id: "agent-ab12cd34", block: true, timeout: 0 });
    expect(agent.seenOpts.map((opts) => opts.block)).toEqual([true, false, true]);
  });
});

describe("task tool entry prechecks (not routed)", () => {
  const hit = (): TaskSource => stubSource({ kind: "agent", probe: { kind: "hit" } }).source;

  it("rejects empty task_id", async () => {
    const world = face([hit()]);
    expect(await world.output({ task_id: "" })).toEqual({ content: "invalid-args:task_id must be a non-empty string", isError: true });
    expect(await world.stop({ task_id: "" })).toEqual({ content: "invalid-args:task_id must be a non-empty string", isError: true });
  });

  it("rejects task_id containing a newline", async () => {
    const world = face([hit()]);
    const out = await world.output({ task_id: "agent-ab12cd34\nx" });
    expect(out.content).toContain("must not contain newlines");
  });

  it("rejects callers without a session", async () => {
    const world = face([hit()]);
    const out = await world.outputNoSession({ task_id: "agent-ab12cd34" });
    expect(out).toEqual({ content: "invalid-args:task tools are only available inside an agent session", isError: true });
  });

  it("rejects task_id 'main' with the denied-style termination", async () => {
    const world = face([hit()]);
    expect(await world.output({ task_id: "main" })).toEqual({ content: "invalid-args:task_id 'main' is not a task", isError: true });
    expect(await world.stop({ task_id: "main" })).toEqual({ content: "invalid-args:task_id 'main' is not a task", isError: true });
  });
});

describe("task_stop routing", () => {
  it("reaches the claiming source's stop", async () => {
    const bash = stubSource({ kind: "bash", probe: { kind: "hit" } });
    const world = face([stubSource({ kind: "agent", probe: { kind: "miss" } }).source, bash.source]);
    const out = await world.stop({ task_id: "t-ab12cd34ef56" });
    expect(out).toEqual({ content: "bash-stopped" });
  });
});
