import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentRequestError } from "@x-harness/agent-loop";
import type { RequestFailure } from "@x-harness/agent-loop";
import { lastRequestContext } from "@x-harness/agent-loop";
import { sessionDisposed, sessionStore } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { backoffDelay, cancellableDelay, DEFAULT_RETRYABLE_CODES, validatePolicy } from "./policy.ts";
import type { RetryPolicy } from "./policy.ts";

export interface LlmRetryOptions {
  readonly providers: Readonly<Record<string, RetryPolicy>>;
  readonly default?: RetryPolicy;
  readonly random?: () => number;
}

function budgetKey(parts: { readonly session: SessionId; readonly providerKey: string; readonly turn: number; readonly step: number }): string {
  return `${parts.session}:${parts.providerKey}:${String(parts.turn)}:${String(parts.step)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

type RequestErrorPayload = {
  readonly session: SessionId;
  readonly turn: number;
  readonly step: number;
  readonly failure: RequestFailure;
  readonly signal: AbortSignal;
};

type RecoveryDecision = { readonly kind: "retry" } | { readonly kind: "respond-to-model"; readonly content: string } | { readonly kind: "fail"; readonly message: string; readonly code: string } | undefined;

const DEFAULT_PROVIDER_KEY = "(default)";

export function createLlmRetryPlugin(options: LlmRetryOptions): Plugin {
  for (const [provider, policy] of Object.entries(options.providers ?? {})) {
    validatePolicy(policy, `providers.${provider}`);
  }
  if (options.default !== undefined) validatePolicy(options.default, "default");
  const random = options.random ?? Math.random;

  return {
    name: "llm-retry",
    inject: ["session"],
    apply: (ctx: Context): Disposer => {
      const store = ctx.use(sessionStore);
      const counts = new Map<string, number>();
      const lifetime = new AbortController();
      const active = new Set<Promise<RecoveryDecision>>();

      const track = (operation: Promise<RecoveryDecision>): Promise<RecoveryDecision> => {
        const tracked = operation.finally(() => active.delete(tracked));
        active.add(tracked);
        return tracked;
      };

      const settleDownstream = async (next: (input: RequestErrorPayload) => Promise<RecoveryDecision>, payload: RequestErrorPayload): Promise<RecoveryDecision> => {
        try {
          return await next(payload);
        } catch (error) {
          process.stderr.write(`llm-retry: downstream recovery threw: ${errorMessage(error)}\n`);
          return undefined;
        }
      };

      interface RetryPlan {
        readonly retry: number;
        readonly providerKey: string;
        readonly delay: number;
      }

      const decide = (payload: RequestErrorPayload): RetryPlan | null => {
        const session = store.get(payload.session);
        if (session === undefined) return null;
        const route = lastRequestContext(session.events());
        const policy = (route !== undefined ? options.providers[route.provider] : undefined) ?? options.default;
        if (policy === undefined) return null;
        const codes = policy.retryableCodes ?? DEFAULT_RETRYABLE_CODES;
        if (payload.failure.code === undefined || !codes.includes(payload.failure.code)) return null;
        const providerKey = route?.provider ?? DEFAULT_PROVIDER_KEY;
        const key = budgetKey({ session: payload.session, providerKey, turn: payload.turn, step: payload.step });
        const retry = (counts.get(key) ?? 0) + 1;
        if (retry > policy.maxRetries) return null;
        const delay = backoffDelay({ policy, retry, retryAfterMs: payload.failure.retryAfterMs, random });
        if (delay === undefined || payload.signal.aborted || lifetime.signal.aborted) return null;
        return { retry, providerKey, delay };
      };

      const schedule = async (payload: RequestErrorPayload, plan: RetryPlan): Promise<RecoveryDecision> => {
        const session = store.get(payload.session);
        if (session !== undefined) {
          const appended = session.append("llm/retry", {
            turn: payload.turn,
            step: payload.step,
            provider: plan.providerKey,
            retry: plan.retry,
            delayMs: plan.delay,
            failure: {
              message: payload.failure.message,
              ...(payload.failure.code !== undefined ? { code: payload.failure.code } : {}),
            },
          });
          if (!appended.ok) return undefined;
        }
        counts.set(budgetKey({ session: payload.session, providerKey: plan.providerKey, turn: payload.turn, step: payload.step }), plan.retry);
        const waited = await cancellableDelay(plan.delay, AbortSignal.any([payload.signal, lifetime.signal]));
        if (!waited) return undefined;
        return { kind: "retry" };
      };

      const recover = async (payload: RequestErrorPayload, next: (input: RequestErrorPayload) => Promise<RecoveryDecision>): Promise<RecoveryDecision> => {
        const downstream = await settleDownstream(next, payload);
        const plan = decide(payload);
        if (plan === null) return downstream;
        return schedule(payload, plan);
      };

      const off = ctx.on(agentRequestError, (payload: RequestErrorPayload, next: (input: RequestErrorPayload) => Promise<RecoveryDecision>) => {
        if (lifetime.signal.aborted) return next(payload);
        return track(recover(payload, next));
      });
      const offDisposed = ctx.on(sessionDisposed, ({ session }: { session: SessionId }) => {
        const prefix = `${session}:`;
        for (const key of counts.keys()) {
          if (key.startsWith(prefix)) counts.delete(key);
        }
      });

      return () => {
        off();
        offDisposed();
        lifetime.abort();
        return Promise.allSettled(active).then(() => {});
      };
    },
  };
}
