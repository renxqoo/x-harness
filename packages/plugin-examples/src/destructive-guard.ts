import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { vetoTools } from "@x-harness/plugin-api";

const DESTRUCTIVE_BASH = /\b(rm\s+-[rf]|git\s+push\s+--force|mkfs|dd\s+if=|:\(\)\{)/;
const DESTRUCTIVE_WRITE = /(\.env|id_rsa|\.ssh\/|\.git\/config)$/;

export interface GuardOptions {
  readonly extraDeny?: (name: string, args: unknown) => string | undefined;
}

export function destructiveGuardPlugin(options: GuardOptions = {}): Plugin {
  return {
    name: "destructive-guard",
    apply: (ctx: Context): Disposer =>
      vetoTools(ctx, (call) => {
        if (call.name === "bash" && DESTRUCTIVE_BASH.test(String((call.args as { command?: unknown }).command ?? ""))) {
          return { kind: "deny", reason: "destructive command pattern blocked (destructive-guard)" };
        }
        if (call.name === "write" && DESTRUCTIVE_WRITE.test(String((call.args as { path?: unknown }).path ?? ""))) {
          return { kind: "deny", reason: "protected path blocked (destructive-guard)" };
        }
        const extra = options.extraDeny?.(call.name, call.args);
        return extra !== undefined ? { kind: "deny", reason: extra } : undefined;
      }),
  };
}
