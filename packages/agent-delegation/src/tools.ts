// 工具族（docs/AGENT-DELEGATION.md §2.1/§3.2.1）：spawn(exclusive)/message/output/list(parallel)/
// stop(exclusive)。schema 与 description 逐字段对账（§2.3）。

import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import type { ToolDefinition, ToolExecContext } from "@x-harness/tools";
import {
  AGENT_MESSAGE_DESCRIPTION,
  AGENT_OUTPUT_DESCRIPTION,
  AGENT_SPAWN_DESCRIPTION,
  AGENT_STOP_DESCRIPTION,
  LIST_AGENTS_DESCRIPTION,
} from "./descriptions.ts";
import type { ChildView } from "./types.ts";
import type { SpawnInput } from "./spawn.ts";
import type { MessageInput, OutputInput, VerbOutcome } from "./verbs.ts";

export interface ToolDeps {
  readonly spawn: (ctx: ToolExecContext, input: SpawnInput) => Promise<VerbOutcome>;
  readonly message: (ctx: ToolExecContext, input: MessageInput) => Promise<VerbOutcome>;
  readonly output: (ctx: ToolExecContext, input: OutputInput) => Promise<VerbOutcome>;
  readonly stop: (ctx: ToolExecContext, taskId: string) => Promise<VerbOutcome>;
  readonly list: (ctx: ToolExecContext) => Promise<readonly ChildView[]>;
}

const CALLER_MISSING = "agent tools are only available inside an agent session";

async function run(result: Promise<VerbOutcome> | VerbOutcome): Promise<{ content: string; isError?: true }> {
  const settled = await result;
  return settled.ok ? { content: settled.text } : { content: settled.reason, isError: true };
}

function viewLines(view: readonly ChildView[]): string {
  return view
    .map((row) =>
      row.kind === "subagent"
        ? `${row.name} [${row.ref}] kind=subagent ${row.agentId} session=${row.sessionId} type=${row.type} depth=${String(row.depth)} status=${row.status}`
        : `${row.name} [${row.ref}] kind=local-session status=${row.status}`,
    )
    .join("\n");
}

const spawnSchema = Type.Object({
  description: Type.String({ description: "A 3-5 word task summary; seeds the agent's name" }),
  prompt: Type.String({ description: "The task for the agent to perform (self-contained — it gets no other initial input)" }),
  subagent_type: Type.Optional(Type.String({ description: "Registered type name or the reserved 'fork'; defaults to an untyped general agent" })),
  model: Type.Optional(Type.String({ description: "Per-call model override (ignored for fork)" })),
  name: Type.Optional(Type.String({ description: "Explicit addressable name (defaults to the description slug)" })),
  isolation: Type.Optional(Type.String({ description: "'worktree': the agent works in its own git worktree copy (auto-cleaned if unchanged)" })),
});

const messageSchema = Type.Object({
  to: Type.String({ description: "agentId, name, 'name [ref]', 'main' (sub-agents), or a local session (box) name" }),
  message: Type.Optional(Type.String({ maxLength: 300, description: "Message content; omit for a pure notify_when_idle subscription. Long content: hand over via files" })),
  summary: Type.Optional(Type.String({ maxLength: 200, description: "Optional label for your own record (not transmitted to the recipient)" })),
  notify_when_idle: Type.Optional(Type.Boolean({ description: "Ask a local session to send ONE notice when it next goes idle — opt-in, one-shot; main conversation only; never poll instead" })),
});

const taskSchema = Type.Object({
  task_id: Type.String({ description: "agentId, name, or 'name [ref]' from agent_spawn/list_agents (owner only)" }),
});

const outputSchema = Type.Object({
  task_id: taskSchema.properties.task_id,
  block: Type.Optional(Type.Boolean({ description: "Wait for completion (default true); false = immediate snapshot" })),
  timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 600000, description: "Max wait in ms when block=true (default 30000)" })),
});

export function delegationTools(deps: ToolDeps): ToolDefinition[] {
  const parallel = (): boolean => true;
  return [
    {
      name: "agent_spawn",
      description: AGENT_SPAWN_DESCRIPTION,
      inputSchema: spawnSchema,
      execute: async (args: Static<typeof spawnSchema>, ctx) => run(await deps.spawn(ctx, args)),
    },
    {
      name: "agent_message",
      description: AGENT_MESSAGE_DESCRIPTION,
      inputSchema: messageSchema,
      execute: async (args: Static<typeof messageSchema>, ctx) => run(deps.message(ctx, args)),
      isConcurrencySafe: parallel,
    },
    {
      name: "agent_output",
      description: AGENT_OUTPUT_DESCRIPTION,
      inputSchema: outputSchema,
      execute: async (args: Static<typeof outputSchema>, ctx) => run(await deps.output(ctx, args)),
      isConcurrencySafe: parallel,
    },
    {
      name: "agent_stop",
      description: AGENT_STOP_DESCRIPTION,
      inputSchema: taskSchema,
      execute: async (args: Static<typeof taskSchema>, ctx) => run(await deps.stop(ctx, args.task_id)),
    },
    {
      name: "list_agents",
      description: LIST_AGENTS_DESCRIPTION,
      inputSchema: Type.Object({}),
      execute: async (_args: Record<string, never>, ctx) => {
        if (ctx.session === undefined) return { content: CALLER_MISSING, isError: true };
        const view = await deps.list(ctx);
        if (view.length === 0) return { content: "(no sub-agents)" };
        return { content: viewLines(view) };
      },
      isConcurrencySafe: parallel,
    },
  ];
}
