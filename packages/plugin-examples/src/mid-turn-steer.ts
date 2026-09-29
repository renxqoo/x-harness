import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { tapToolCalls, transformMessages } from "@x-harness/plugin-api";
import type { ToolCallRequest } from "@x-harness/tools";

export interface SteerOptions {
  readonly afterToolCalls: number;
  readonly message: string;
}

export function midTurnSteerPlugin(options: SteerOptions): Plugin {
  return {
    name: "mid-turn-steer",
    inject: ["agent-loop"],
    apply: (ctx: Context): Disposer => {
      let toolCalls = 0;
      let shouldSteer = false;
      const offTap = tapToolCalls(ctx, (_request: ToolCallRequest) => {
        toolCalls += 1;
        if (toolCalls >= options.afterToolCalls) shouldSteer = true;
      });
      const offInject = transformMessages(ctx, (claim: readonly import("@x-harness/session").InboxEntry[]) => {
        if (!shouldSteer) return claim;
        shouldSteer = false;
        toolCalls = 0;
        const steer: import("@x-harness/session").InboxEntry = {
          id: `steer-${String(Date.now())}`,
          content: [{ type: "text", text: options.message } as { type: "text"; text: string }],
        };
        return [steer, ...claim];
      });
      return () => {
        offInject();
        offTap();
      };
    },
  };
}
