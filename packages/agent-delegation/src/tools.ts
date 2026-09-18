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
        ? `kind=subagent ${row.agentId} session=${row.sessionId} type=${row.type} depth=${String(row.depth)} status=${row.status}`
        : `${row.name} [${row.ref}] kind=local-session status=${row.status}`,
    )
    .join("\n");
}

const spawnSchema = Type.Object({
  description: Type.String({ description: "A short (3-5 word) description of the task" }),
  prompt: Type.String({ description: "The task for the agent to perform" }),
  subagent_type: Type.Optional(Type.String({ description: "The type of specialized agent to use for this task" })),
  model: Type.Optional(Type.String({ description: "Optional model override for this agent. Takes precedence over the agent definition's model frontmatter and the configured default subagent model. If omitted, uses the agent definition's model, else the default (inherits from the parent unless a default subagent model is configured). Ignored for subagent_type: \"fork\" — forks always inherit the parent model." })),
  isolation: Type.Optional(Type.Union([Type.Literal("worktree"), Type.Literal("remote")], { description: "Isolation mode. \"worktree\" creates a temporary git worktree so the agent works on an isolated copy of the repo. \"remote\" launches the agent in a remote cloud environment (always runs in background; availability is gated)." })),
});

const messageSchema = Type.Object({
  to: Type.String({
    pattern: "^[^\\n\\r]*$",
    description: "Recipient: a name from ListAgents (append its ' [ref]' only when a listing or an error shows one), a teammate name, 'main', or a background agent's agentId",
  }),
  message: Type.String({
    pattern: "^[\\s\\S]{0,300}$",
    description: "Plain text message content. The recipient's human sees only the FIRST LINE as a one-line preview until they expand it, so make the first line a clear, self-contained sentence saying what this is about — not a greeting, preamble, or bare @-mention.",
  }),
  summary: Type.Optional(Type.String({
    maxLength: 200,
    description: "A 5-10 word label for your own transcript row (not transmitted — the recipient previews the first line of \`message\`). Truncated to 200 characters rather than rejected.",
  })),
  notify_when_idle: Type.Optional(Type.Boolean({
    description: "Ask a session ON THIS MACHINE to send you ONE notice when it next goes idle (finishes its turn with nothing queued) or exits — opt-in, one-shot, no polling. With a message: deliver it now AND subscribe. Without a message (omit it): a pure subscription that costs the other session nothing.",
  })),
});

const taskSchema = Type.Object({
  task_id: Type.String({ description: "The task ID to get output for" }),
});

const outputSchema = Type.Object({
  task_id: taskSchema.properties.task_id,
  block: Type.Optional(Type.Boolean({ description: "Whether to wait for completion" })),
  timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 600000, description: "Max wait time in ms" })),
});

const stopSchema = Type.Object({
  task_id: Type.String({ description: "The ID of the background task to stop" }),
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
      inputSchema: stopSchema,
      execute: async (args: Static<typeof stopSchema>, ctx) => run(await deps.stop(ctx, args.task_id)),
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
