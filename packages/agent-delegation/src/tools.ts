// 工具族（docs/AGENT-DELEGATION.md §2.1/§3.2.1 + docs/DELEGATION-LONG-CONTENT.md 件15 D6/D7）：
// spawn(exclusive)/message/list(parallel)。message 上限 = 注入 reportCap（D1 恒等——单旋钮，
// 截断-追问闭环的结构保证），载体 maxLength（D6——报错为直接数字，pattern 载体数字埋在
// 正则语法里）；summary 去 schema 上限（D7——元数据吸收性截断，verb 层 SUMMARY_CAP 兑现
// description 的截断承诺）。停动词 task_stop 归 @x-harness/task-tools（件14）——本包经
// agentTaskSource 注册 agent 源；报告读面归 [agent-notification] 推送。

import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import type { ToolDefinition, ToolExecContext } from "@x-harness/tools";
import {
  AGENT_MESSAGE_DESCRIPTION,
  AGENT_SPAWN_DESCRIPTION,
  LIST_AGENTS_DESCRIPTION,
} from "./descriptions.ts";
import type { ChildView } from "./types.ts";
import type { SpawnInput } from "./spawn.ts";
import type { MessageInput, VerbOutcome } from "./verbs.ts";

export interface ToolDeps {
  readonly spawn: (ctx: ToolExecContext, input: SpawnInput) => Promise<VerbOutcome>;
  readonly message: (ctx: ToolExecContext, input: MessageInput) => Promise<VerbOutcome>;
  readonly list: (ctx: ToolExecContext) => Promise<readonly ChildView[]>;
  /** message 上限（D1 恒等 = reportCap——validateOptions 已算好的注入值） */
  readonly reportCap: number;
}

const CALLER_MISSING = "agent tools are only available inside an agent session";

async function run(result: Promise<VerbOutcome> | VerbOutcome): Promise<{ content: string; isError?: true }> {
  const settled = await result;
  return settled.ok ? { content: settled.text } : { content: settled.reason, isError: true };
}

function viewLines(view: readonly ChildView[]): string {
  const lines = view.map((row) =>
    row.kind === "subagent"
      ? `kind=subagent ${row.agentId} session=${row.sessionId} type=${row.type} depth=${String(row.depth)} status=${row.status}${row.work !== undefined ? ` work=${row.work}` : ""}`
      : `${row.name} [${row.ref}] kind=local-session status=${row.status}`,
  );
  // running 行在场 → 尾附等待提示（反轮询执法读面）：结束 turn 等通知，禁 sleep/list_agents 自旋
  if (view.some((row) => row.status === "running")) {
    lines.push("Agents marked running are still working — end your turn and wait for the [agent-notification] (it wakes you); do not poll with sleep or repeated list_agents calls.");
  }
  return lines.join("\n");
}

const spawnSchema = Type.Object({
  description: Type.String({ description: "A short (3-5 word) description of the task" }),
  prompt: Type.String({ description: "The task for the agent to perform" }),
  subagent_type: Type.Optional(Type.String({ description: "The type of specialized agent to use for this task" })),
  model: Type.Optional(Type.String({ description: "Optional model override for this agent. Takes precedence over the agent definition's model frontmatter and the configured default subagent model. If omitted, uses the agent definition's model, else the default (inherits from the parent unless a default subagent model is configured). Ignored for subagent_type: \"fork\" — forks always inherit the parent model." })),
  isolation: Type.Optional(Type.Union([Type.Literal("worktree"), Type.Literal("remote")], { description: "Isolation mode. \"worktree\" creates a temporary git worktree so the agent works on an isolated copy of the repo. \"remote\" launches the agent in a remote cloud environment (always runs in background; availability is gated)." })),
});

/** message schema（工厂内构造——maxLength 按注入 reportCap 插值，件15 批1） */
const messageSchemaOf = (reportCap: number) =>
  Type.Object({
    to: Type.String({
      pattern: "^[^\\n\\r]*$",
      description: "Recipient: a name from ListAgents (append its ' [ref]' only when a listing or an error shows one), a teammate name, 'main', or a background agent's agentId",
    }),
    message: Type.String({
      maxLength: reportCap,
      description: "Plain text message content. The recipient's human sees only the FIRST LINE as a one-line preview until they expand it, so make the first line a clear, self-contained sentence saying what this is about — not a greeting, preamble, or bare @-mention. For long content, write it to a file and send a short message with the file path instead of inlining it.",
    }),
    summary: Type.Optional(Type.String({
      description: 'A 5-10 word label for your own transcript row (not transmitted — the recipient previews the first line of `message`). Truncated to 500 characters rather than rejected.',
    })),
    notify_when_idle: Type.Optional(Type.Boolean({
      description: "Ask a session ON THIS MACHINE to send you ONE notice when it next goes idle (finishes its turn with nothing queued) or exits — opt-in, one-shot, no polling. With a message: deliver it now AND subscribe. Without a message (omit it): a pure subscription that costs the other session nothing.",
    })),
  });

export function delegationTools(deps: ToolDeps): ToolDefinition[] {
  const parallel = (): boolean => true;
  return [
    {
      name: "agent_spawn",
      description: AGENT_SPAWN_DESCRIPTION,
      inputSchema: spawnSchema,
      isControlTool: true,
      execute: async (args: Static<typeof spawnSchema>, ctx) => run(await deps.spawn(ctx, args)),
    },
    {
      name: "agent_message",
      description: AGENT_MESSAGE_DESCRIPTION,
      inputSchema: messageSchemaOf(deps.reportCap),
      isControlTool: true,
      execute: async (args: Static<ReturnType<typeof messageSchemaOf>>, ctx) => run(deps.message(ctx, args)),
      isConcurrencySafe: parallel,
    },
    {
      name: "list_agents",
      description: LIST_AGENTS_DESCRIPTION,
      inputSchema: Type.Object({}),
      isControlTool: true,
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
