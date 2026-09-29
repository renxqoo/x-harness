import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { sessionCreateGuard } from "@x-harness/session";

export interface GuardRule {
  readonly check: (header: { readonly agentDepth?: number; readonly cwd?: string; readonly parentSession?: string }) => string | undefined;
}

export function sessionGuardPlugin(rule: GuardRule): Plugin {
  return {
    name: "session-guard",
    inject: ["session"],
    apply: (ctx: Context): Disposer =>
      ctx.on(sessionCreateGuard, (payload) => {
        const header = (payload as { header?: { readonly agentDepth?: number; readonly cwd?: string; readonly parentSession?: string } }).header;
        if (header === undefined) return;
        const reason = rule.check(header);
        if (reason !== undefined) return { kind: "deny", reason };
      }),
  };
}
