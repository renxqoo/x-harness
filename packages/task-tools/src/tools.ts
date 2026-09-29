import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@x-harness/tools";
import type { SessionId } from "@x-harness/session";
import type { TaskHub, TaskOutcome, TaskProbe, TaskSource } from "./tokens.ts";
import { TASK_STOP_DESCRIPTION } from "./descriptions.ts";

const CALLER_MISSING = "invalid-args:task tools are only available inside an agent session";

export function notFoundText(taskId: string): string {
  return `not-found:${taskId}; no such task in any source (agent tasks: use list_agents; bash ids come from bash run_in_background; bash tasks are session-scoped)`;
}

const stopSchema = Type.Object({
  task_id: Type.String({ description: "The ID of the background task to stop" }),
});

function precheck(taskId: string, caller: SessionId | undefined): string | undefined {
  if (taskId === "") return "invalid-args:task_id must be a non-empty string";
  if (taskId.includes("\n") || taskId.includes("\r")) return "invalid-args:task_id must not contain newlines";
  if (caller === undefined) return CALLER_MISSING;
  if (taskId === "main") return "invalid-args:task_id 'main' is not a task";
  return undefined;
}

async function route(input: {
  readonly hub: TaskHub;
  readonly onWarn: (message: string) => void;
  readonly taskId: string;
  readonly caller: SessionId;
  readonly run: (source: TaskSource) => Promise<TaskOutcome>;
}): Promise<TaskOutcome> {
  for (const source of input.hub.sources()) {
    let probe: TaskProbe;
    try {
      probe = source.probe(input.taskId, input.caller);
    } catch (error) {
      input.onWarn(`task-tools: source '${source.kind}' probe threw for '${input.taskId}': ${String(error)}`);
      continue;
    }
    if (probe.kind === "miss") continue;
    if (probe.kind === "denied") return { ok: false, reason: probe.reason };
    try {
      const out = await input.run(source);
      if (!out.ok && out.reason.startsWith("not-found:")) continue;
      return out;
    } catch (error) {
      input.onWarn(`task-tools: source '${source.kind}' threw for '${input.taskId}': ${String(error)}`);
      continue;
    }
  }
  return { ok: false, reason: notFoundText(input.taskId) };
}

function cast(out: TaskOutcome): { content: string; isError?: true } {
  return out.ok ? { content: out.text } : { content: out.reason, isError: true };
}

export function createTaskTools(hub: TaskHub, onWarn: (message: string) => void = () => {}): ToolDefinition[] {
  return [
    {
      name: "task_stop",
      description: TASK_STOP_DESCRIPTION,
      inputSchema: stopSchema,
      execute: async (args: Static<typeof stopSchema>, ctx) => {
        const bad = precheck(args.task_id, ctx.session);
        if (bad !== undefined) return { content: bad, isError: true };
        return cast(await route({ hub, onWarn, taskId: args.task_id, caller: ctx.session as SessionId, run: (source) => source.stop(args.task_id, ctx.session) }));
      },
    },
  ];
}
