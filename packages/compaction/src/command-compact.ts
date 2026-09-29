import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentLoopServiceToken } from "@x-harness/agent-loop";
import { commandRegistry } from "@x-harness/commands";
import type { CommandResult } from "@x-harness/commands";
import { compactionRunner } from "./tokens.ts";
import { previousSummaryOf } from "./compact.ts";

export const COMPACT_KEEP_RECENT_TOKENS = 20_000;

export function compactSkipError(reason: string): string {
  if (reason === "no-cut-point" || reason === "summary-input-budget-exhausted" || reason === "summary-empty") {
    return "context too small to compact";
  }
  if (reason === "summarizer-unconfigured") return "compaction summarizer not configured";
  if (reason === "aborted") return "compaction aborted";
  return `compaction failed: ${reason}`;
}

export const commandCompactPlugin = {
  name: "command-compact",
  inject: ["commands", "compaction"],
  apply: (ctx: Context): Disposer => {
    const registry = ctx.use(commandRegistry);
    const runner = ctx.use(compactionRunner);
    let running = false;

    const off = registry.register({
      name: "compact",
      description: "Compact the conversation history",
      execute: async ({ session, rawInput, signal }): Promise<CommandResult> => {
        const loop = ctx.tryUse(agentLoopServiceToken);
        if (loop?.get(session.id)?.agent.status === "running") {
          return { kind: "error", text: "thread is streaming" };
        }
        if (running) return { kind: "error", text: "Compaction already in progress" };
        running = true;
        try {
          const customInstructions = rawInput.trim() !== "" ? rawInput.trim() : undefined;
          const result = await runner.compact({
            session: session.id,
            trigger: "manual",
            signal,
            ...(customInstructions !== undefined ? { customInstructions } : {}),
          });
          if (!result.ok) return { kind: "error", text: compactSkipError(result.reason) };
          return {
            kind: "success",
            data: {
              summary: previousSummaryOf(session.surface()),
              replacedCount: result.replacedNodes,
              summaryTokens: result.summaryTokens,
            },
          };
        } finally {
          running = false;
        }
      },
    });
    return off;
  },
} satisfies Plugin;
