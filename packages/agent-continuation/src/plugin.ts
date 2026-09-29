import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentTurnConclude } from "@x-harness/agent-loop";
import type { TurnConcludeDecision, TurnConcludePayload } from "@x-harness/agent-loop";
import { sessionStore } from "@x-harness/session";
import { continuationsSinceStop } from "./count.ts";
import { decideContinuation, validateMaxOutputContinuations } from "./policy.ts";

export interface ContinuationOptions {
  readonly maxOutputContinuations?: number;
}

export const createContinuationPlugin = (options?: ContinuationOptions): Plugin => {
  const max = validateMaxOutputContinuations(options?.maxOutputContinuations);
  return {
    name: "agent-continuation",
    inject: ["session"],
    apply: (ctx: Context): Disposer => {
      const store = ctx.use(sessionStore);
      return ctx.on(agentTurnConclude, async (payload: TurnConcludePayload, next: (input: TurnConcludePayload) => Promise<TurnConcludeDecision | undefined>) => {
        const downstream = await next(payload);
        if (downstream !== undefined) return downstream;
        const live = store.get(payload.session);
        if (live === undefined) return downstream;
        const count = continuationsSinceStop(live.events(), payload.turn);
        return decideContinuation({ stopReason: payload.stopReason, content: payload.content, hasThinking: payload.hasThinking, hasTools: payload.hasTools, truncatedCount: payload.truncatedCount, signal: payload.signal, count, max }) ?? downstream;
      });
    },
  } satisfies Plugin;
};
