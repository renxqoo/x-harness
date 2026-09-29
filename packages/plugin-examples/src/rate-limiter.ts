import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { vetoTools } from "@x-harness/plugin-api";

export interface RateLimiterOptions {
  readonly maxCallsPerWindow: number;
  readonly windowMs?: number;
  readonly toolName?: string;
}

export function rateLimiterPlugin(options: RateLimiterOptions): Plugin {
  const windowMs = options.windowMs ?? 60_000;
  return {
    name: "rate-limiter",
    apply: (ctx: Context): Disposer => {
      const hits: number[] = [];
      return vetoTools(ctx, (call) => {
        if (options.toolName !== undefined && call.name !== options.toolName) return undefined;
        const now = Date.now();
        while (hits.length > 0 && now - (hits[0] ?? 0) > windowMs) hits.shift();
        if (hits.length >= options.maxCallsPerWindow) {
          return { kind: "deny", reason: `rate limit: ${String(options.maxCallsPerWindow)} calls per ${String(windowMs)}ms (rate-limiter)` };
        }
        hits.push(now);
        return undefined;
      });
    },
  };
}
