// llm-retry 插件（docs/LLM-RETRY.md §1）：挂 agentRequestError waterfall 的退避重试策略。
// 预算 = 进程内 per-(provider, turn, step) 计数；llm/retry 事件先于等待落账（审计时序）；
// 等待可取消（turn signal + 插件 lifetime）；dispose abort 并排空在途等待。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentRequestError } from "@x-harness/agent-loop";
import type { RequestFailure } from "@x-harness/agent-loop";
import { lastRequestContext } from "@x-harness/agent-loop";
import { sessionDisposed, sessionStore } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { backoffDelay, cancellableDelay, DEFAULT_RETRYABLE_CODES, validatePolicy } from "./policy.ts";
import type { RetryPolicy } from "./policy.ts";

export interface LlmRetryOptions {
  /** 键 = provider 名（末次 request/context 折叠） */
  readonly providers: Readonly<Record<string, RetryPolicy>>;
  /** 无路线记录（含单适配器无显式 provider 的最小部署）或 providers 命不中时的缺省策略 */
  readonly default?: RetryPolicy;
  /** 测试注入：抖动随机源（缺省 Math.random） */
  readonly random?: () => number;
}

/** 预算键：含 session id——turn/step 是每会话序号，跨会话共享键会互相烧预算 */
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

      // 下游（更晚注册的 recovery 中间件 + 缺省 final）先行——内核 I2：中间件必须调 next；
      // 下游异常吞为 undefined（我们的策略不因下游崩而失效）
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

      /** 策略归属与可重试判定（纯决策，无副作用）：null = 委托下游（含会话不在店——审计落不上不重试） */
      const decide = (payload: RequestErrorPayload): RetryPlan | null => {
        const session = store.get(payload.session);
        if (session === undefined) return null;
        const route = lastRequestContext(session.events());
        const policy = (route !== undefined ? options.providers[route.provider] : undefined) ?? options.default;
        if (policy === undefined) return null; // 无策略归属：委托
        const codes = policy.retryableCodes ?? DEFAULT_RETRYABLE_CODES;
        if (payload.failure.code === undefined || !codes.includes(payload.failure.code)) return null; // 非瞬态：零定时器直达
        const providerKey = route?.provider ?? DEFAULT_PROVIDER_KEY;
        const key = budgetKey({ session: payload.session, providerKey, turn: payload.turn, step: payload.step });
        const retry = (counts.get(key) ?? 0) + 1;
        if (retry > policy.maxRetries) return null; // 预算烧尽：缺省终态 error
        const delay = backoffDelay({ policy, retry, retryAfterMs: payload.failure.retryAfterMs, random });
        if (delay === undefined || payload.signal.aborted || lifetime.signal.aborted) return null; // Retry-After 超上限 / 落账前已取消
        return { retry, providerKey, delay };
      };

      /** 审计落账 + 可取消等待（副作用段）：落不上或取消 → 不重试 */
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
          if (!appended.ok) return undefined; // 已封存等：审计落不上 → 不重试（fail-closed）
        }
        counts.set(budgetKey({ session: payload.session, providerKey: plan.providerKey, turn: payload.turn, step: payload.step }), plan.retry);
        const waited = await cancellableDelay(plan.delay, AbortSignal.any([payload.signal, lifetime.signal]));
        if (!waited) return undefined; // 取消胜出：不重拨（驱动按 aborted 收尾 / 插件已卸载）
        return { kind: "retry" };
      };

      const recover = async (payload: RequestErrorPayload, next: (input: RequestErrorPayload) => Promise<RecoveryDecision>): Promise<RecoveryDecision> => {
        const downstream = await settleDownstream(next, payload); // 内核 I2：必须调 next（下游先行）
        const plan = decide(payload);
        if (plan === null) return downstream;
        return schedule(payload, plan);
      };

      const off = ctx.on(agentRequestError, (payload: RequestErrorPayload, next: (input: RequestErrorPayload) => Promise<RecoveryDecision>) => {
        if (lifetime.signal.aborted) return next(payload); // dispose 后被捕获的旧回调：委托不进策略
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
