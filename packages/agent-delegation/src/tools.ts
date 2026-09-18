// 工具族（docs/AGENT-DELEGATION.md §1.1/§1.2.1）：spawn(exclusive)/message/output/list(parallel)/stop(exclusive)。
// 属主校验（callerSession === row.parent）；报告 cap 截断；description 逐字常量见 descriptions.ts。

import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolExecContext } from "@x-harness/tools";
import {
  AGENT_MESSAGE_DESCRIPTION,
  AGENT_OUTPUT_DESCRIPTION,
  AGENT_SPAWN_DESCRIPTION,
  AGENT_STOP_DESCRIPTION,
  LIST_AGENTS_DESCRIPTION,
} from "./descriptions.ts";
import type { ChildRow } from "./lineage.ts";
import type { ChildReport } from "./notify.ts";
import type { ChildView } from "./types.ts";

export interface ToolDeps {
  readonly spawn: (ctx: ToolExecContext, input: { prompt: string; type?: string; name?: string }) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  readonly message: (ctx: ToolExecContext, agentId: string, text: string) => { ok: true; text: string } | { ok: false; reason: string };
  readonly output: (ctx: ToolExecContext, agentId: string) => { ok: true; text: string } | { ok: false; reason: string };
  readonly stop: (ctx: ToolExecContext, agentId: string) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  readonly list: (ctx: ToolExecContext) => readonly ChildView[];
}

const CALLER_MISSING = "agent tools are only available inside an agent session";

export function delegationTools(deps: ToolDeps): ToolDefinition[] {
  const parallel = (): boolean => true;
  return [
    {
      name: "agent_spawn",
      description: AGENT_SPAWN_DESCRIPTION,
      inputSchema: Type.Object({
        prompt: Type.String({ description: "The sub-agent's task (its only initial input; must be self-contained)" }),
        type: Type.Optional(Type.String({ description: "Registered type name or 'fork'; defaults to an untyped agent" })),
        name: Type.Optional(Type.String({ description: "Display name (cosmetic, may repeat; never an address)" })),
      }),
      execute: async (args, ctx) => run(await deps.spawn(ctx, args as { prompt: string; type?: string; name?: string })),
    },
    {
      name: "agent_message",
      description: AGENT_MESSAGE_DESCRIPTION,
      inputSchema: Type.Object({
        agentId: Type.String({ description: "agentId from agent_spawn (owner only)" }),
        text: Type.String({ description: "Message content" }),
      }),
      isConcurrencySafe: parallel,
      execute: async (args, ctx) => run(deps.message(ctx, (args as { agentId: string; text: string }).agentId, (args as { agentId: string; text: string }).text)),
    },
    {
      name: "agent_output",
      description: AGENT_OUTPUT_DESCRIPTION,
      inputSchema: Type.Object({ agentId: Type.String({ description: "agentId from agent_spawn (owner only)" }) }),
      isConcurrencySafe: parallel,
      execute: async (args, ctx) => run(deps.output(ctx, (args as { agentId: string }).agentId)),
    },
    {
      name: "agent_stop",
      description: AGENT_STOP_DESCRIPTION,
      inputSchema: Type.Object({ agentId: Type.String({ description: "agentId from agent_spawn (owner only)" }) }),
      execute: async (args, ctx) => run(await deps.stop(ctx, (args as { agentId: string }).agentId)),
    },
    {
      name: "list_agents",
      description: LIST_AGENTS_DESCRIPTION,
      inputSchema: Type.Object({}),
      isConcurrencySafe: parallel,
      execute: async (_args, ctx) => {
        if (ctx.session === undefined) return { content: CALLER_MISSING, isError: true };
        const view = deps.list(ctx);
        if (view.length === 0) return { content: "(no sub-agents)" };
        return { content: view.map((row) => `${row.agentId} session=${row.sessionId} name=${row.name} type=${row.type} depth=${String(row.depth)} status=${row.status}`).join("\n") };
      },
    },
  ];
}

function run(result: { ok: true; text: string } | { ok: false; reason: string }): { content: string; isError?: true } {
  return result.ok ? { content: result.text } : { content: result.reason, isError: true };
}

/** 报告铸文本：cap 截断 + agent_message 追问引导（无文件指针） */
export function reportText(row: ChildRow, report: ChildReport, cap: number): string {
  const head = `agent ${row.agentId} (${row.name}) last turn: ${report.status}`;
  if (report.summary === undefined) return `${head}\n(no assistant output in the last turn)`;
  if (report.summary.length <= cap) return `${head}\n${report.summary}`;
  return `${head}\n${report.summary.slice(0, cap)}\n[report truncated at ${String(cap)} chars; use agent_message to ask the agent for specifics]`;
}

export function notFound(agentId: string): string {
  return `not-found:${agentId}; use list_agents to see your sub-agents`;
}
