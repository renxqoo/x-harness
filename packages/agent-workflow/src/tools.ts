// workflow_submit 工具面（docs/AGENT-WORKFLOW.md §9 外部契约 + W7 命名）。

import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@x-harness/tools";
import type { SubmitInput, WorkflowRuntime } from "./types.ts";

const CALLER_MISSING = "workflow tools are only available inside the main conversation";

export const WORKFLOW_SUBMIT_DESCRIPTION = `# workflow_submit

Submit a managed task with acceptance gating: the deliverable must pass verification before it counts as done, and failures are returned to the sub-agent for repair (within budget) instead of being reported as complete.

\`\`\`json
{"description": "fix login bug", "prompt": "Fix the login bug in auth.ts", "acceptance": {"command": "bun run test src/auth"}}
\`\`\`

## When to Use

Use when the deliverable must be verified: a verification command (tests/build), a required result structure (result_schema), or — for exploration or delegation without verification — prefer agent_spawn instead.

## Parameters

- **description** (string, required): 3-5 word task summary.
- **prompt** (string, required): the task instructions. For result_schema tasks the final message must be a JSON value matching the schema (this is repeated in the dispatch prompt).
- **subagent_type / model / isolation**: passed through to the underlying agent spawn.
- **result_schema** (JSON Schema, optional): the deliverable must be a JSON value matching this schema — extracted from the final message, validated, and rejected back for repair on mismatch.
- **acceptance** (object, optional): { "command": string, "cwd"?: string } — the command runs in a sandbox after the agent finishes; non-zero exit rejects the deliverable back for repair. cwd defaults to the task workspace (worktree when isolated).
- **max_attempts** (number, optional): override the repair budget.

## Behavior

- Without any of result_schema / acceptance / critic, this tool delegates directly (identical to agent_spawn — the notification arrives from the agent as usual).
- With verification: the task settles only when verification passes (or the budget is exhausted, which fails it). A [workflow-notification] then arrives with the verdict, attempts, evidence, and the agent session pointer.
- The task runs in the background — end your turn and wait; do not poll.`;

const submitSchema = Type.Object({
  description: Type.String({ description: "A short (3-5 word) description of the task" }),
  prompt: Type.String({ description: "The task for the agent to perform. With result_schema: the final message must be a JSON value matching it." }),
  subagent_type: Type.Optional(Type.String({ description: "The type of specialized agent to use" })),
  model: Type.Optional(Type.String({ description: "Optional model override" })),
  isolation: Type.Optional(Type.Union([Type.Literal("worktree")], { description: "Isolation mode: a temporary git worktree so the agent works on an isolated copy" })),
  result_schema: Type.Optional(Type.Unknown({ description: "JSON Schema the deliverable must match (Tier A structural acceptance)" })),
  acceptance: Type.Optional(Type.Object({
    command: Type.String({ description: "Verification command; non-zero exit rejects the deliverable back for repair" }),
    cwd: Type.Optional(Type.String({ description: "Working directory for the command (defaults to the task workspace)" })),
  })),
  critic: Type.Optional(Type.Object({
    type: Type.String({ description: "Critic agent type (.md definition) — Tier C (period 2)" }),
    focus: Type.Optional(Type.String({ description: "Review focus" })),
  })),
  max_attempts: Type.Optional(Type.Number({ description: "Override the repair budget (default 3)" })),
});

export function workflowSubmitTool(runtime: WorkflowRuntime): ToolDefinition {
  return {
    name: "workflow_submit",
    description: WORKFLOW_SUBMIT_DESCRIPTION,
    inputSchema: submitSchema,
    isControlTool: true,
    execute: async (args: Static<typeof submitSchema>, ctx) => {
      if (ctx.session === undefined) return { content: CALLER_MISSING, isError: true };
      const outcome = await runtime.submit(ctx.session, args as SubmitInput);
      return outcome.ok ? { content: outcome.text } : { content: outcome.reason, isError: true };
    },
  };
}
