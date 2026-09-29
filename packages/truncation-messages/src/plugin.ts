import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentTruncatedTool } from "@x-harness/agent-loop";
import type { TruncatedToolDecision, TruncatedToolPayload } from "@x-harness/agent-loop";
import { TRUNCATED_TOOL_FULL_MESSAGE } from "./message.ts";

export const createDefaultTruncationMessages = (): Plugin => ({
  name: "truncation-messages",
  apply: (ctx: Context): Disposer =>
    ctx.on(agentTruncatedTool, async (payload: TruncatedToolPayload, next: (input: TruncatedToolPayload) => Promise<TruncatedToolDecision>) => {
      const downstream = await next(payload);
      if (payload.signal.aborted) return downstream;
      if (downstream === undefined) return { content: TRUNCATED_TOOL_FULL_MESSAGE };
      if (typeof downstream === "object" && "note" in downstream && typeof (downstream as { note?: unknown }).note === "string") {
        return { content: `${TRUNCATED_TOOL_FULL_MESSAGE}\n${(downstream as { note: string }).note}` };
      }
      return downstream;
    }),
}) satisfies Plugin;
