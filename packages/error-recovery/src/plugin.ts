import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentRequestError, agentTurnConclude } from "@x-harness/agent-loop";
import type { RequestErrorDecision, RequestFailure, TurnConcludeDecision } from "@x-harness/agent-loop";
import { OUTPUT_CONTINUATION_INSTRUCTION } from "./instruction.ts";
import { sessionEvent, sessionStore } from "@x-harness/session";
import type { SessionEvent, SessionId } from "@x-harness/session";
import { classifyFailure, DEFAULT_FAMILY_ACTIONS } from "./classify.ts";
import type { ErrorFamily, FamilyAction } from "./classify.ts";
import { allToolResultsErrored, hasCompactionLedger } from "./ledger.ts";
import { sanitizeErrorMessage } from "./sanitize.ts";

export const ERROR_RECOVERY_SOURCE = "error-recovery";

export interface ErrorRecoveryOptions {
  readonly maxConsecutiveFailures?: number;
  readonly maxTotalFailures?: number;
  readonly recoverableFamilies?: Readonly<Partial<Record<ErrorFamily, FamilyAction>>>;
}

const PERSIST_WARN = "if this error persists, stop and report";

function validateLimit(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer (got ${String(value)})`);
  }
  return value;
}

type RecoveryDecision = RequestErrorDecision | undefined;
type ConcludeDecision = TurnConcludeDecision | undefined;

interface Counters {
  readonly byFamily: Map<ErrorFamily, number>;
  total: number;
}

const L1_RETRYABLE_CODES: ReadonlySet<string> = new Set(["network", "http-408", "http-429", "http-500", "http-502", "http-503", "http-504"]);

function decideRecovery(input: {
  readonly failure: RequestFailure;
  readonly own: Counters;
  readonly compactionHealed: () => boolean;
  readonly actions: Readonly<Record<ErrorFamily, FamilyAction>>;
  readonly maxFamily: number;
  readonly maxTotal: number;
}): RequestErrorDecision | undefined {
  const code = input.failure.code;
  if (code !== undefined && L1_RETRYABLE_CODES.has(code) && input.failure.rawReason === undefined) {
    return undefined;
  }
  const family = classifyFailure(code);
  const action = input.actions[family];
  const nextFamily = (input.own.byFamily.get(family) ?? 0) + 1;
  const nextTotal = input.own.total + 1;
  const overLimit = nextFamily > input.maxFamily || nextTotal > input.maxTotal;
  input.own.byFamily.set(family, nextFamily);
  input.own.total = nextTotal;
  if (!overLimit && action === "respond") {
    return {
      kind: "respond-to-model",
      content: `${sanitizeErrorMessage(input.failure.message)}\n\nThe request failed. Adjust your approach and retry. ${PERSIST_WARN}.`,
    };
  }
  const dead = action === "fail" && (family !== "context-overflow" || input.compactionHealed());
  return {
    kind: "fail",
    message: dead
      ? `${input.failure.message}${overLimit ? ` (consecutive ${family} failures: ${String(nextFamily)}, total: ${String(nextTotal)})` : ""}`
      : `retry budget exhausted (${family}): ${input.failure.message}`,
    code: overLimit ? `${ERROR_RECOVERY_SOURCE}-limit` : input.failure.code ?? family,
  };
}

export const createErrorRecoveryPlugin = (options?: ErrorRecoveryOptions): Plugin => {
  const maxFamily = validateLimit(options?.maxConsecutiveFailures, "maxConsecutiveFailures", 3);
  const maxTotal = validateLimit(options?.maxTotalFailures, "maxTotalFailures", 5);
  const actions: Readonly<Record<ErrorFamily, FamilyAction>> = { ...DEFAULT_FAMILY_ACTIONS, ...options?.recoverableFamilies };

  return {
    name: "error-recovery",
    inject: ["session"],
    apply: (ctx: Context): Disposer => {
      const store = ctx.use(sessionStore);
      const counters = new Map<SessionId, Counters>();
      const countersOf = (session: SessionId): Counters => {
        let own = counters.get(session);
        if (own === undefined) {
          own = { byFamily: new Map(), total: 0 };
          counters.set(session, own);
        }
        return own;
      };
      const reset = (session: SessionId): void => {
        counters.delete(session);
      };

      const offEvents = ctx.on(sessionEvent, ({ session, event }: { readonly session: SessionId; readonly event: SessionEvent }) => {
        if (event.type === "tool/result" && event.data.isError !== true) reset(session);
        else if (event.type === "assistant/message" && event.data.stopReason === "stop") reset(session);
      });

      const offRequest = ctx.on(agentRequestError, async (payload, next): Promise<RecoveryDecision> => {
        let downstream: RecoveryDecision;
        try {
          downstream = await next(payload);
        } catch (error) {
          process.stderr.write(`error-recovery: downstream recovery threw: ${error instanceof Error ? error.message : String(error)}\n`);
          return undefined;
        }
        if (downstream !== undefined) return downstream;
        if (payload.signal.aborted) return downstream;
        const session = store.get(payload.session);
        if (session === undefined) return downstream;
        return decideRecovery({
          failure: payload.failure,
          own: countersOf(payload.session),
          compactionHealed: () => hasCompactionLedger(session.events()),
          actions,
          maxFamily,
          maxTotal,
        });
      });

      const offConclude = ctx.on(agentTurnConclude, async (payload, next): Promise<ConcludeDecision> => {
        const downstream = await next(payload);
        if (downstream !== undefined) return downstream;
        if (payload.signal.aborted || payload.stopReason !== "max-tokens" || payload.hasTools !== true) return downstream;
        const session = store.get(payload.session);
        if (session === undefined) return downstream;
        if (!allToolResultsErrored(session.events(), { turn: payload.turn, step: payload.step })) return downstream;
        const own = countersOf(payload.session);
        own.total += 1;
        if (own.total > maxTotal) {
          return { kind: "fail", message: "output limit hit after failed tool calls; recovery budget exhausted", code: `${ERROR_RECOVERY_SOURCE}-limit` };
        }
        return { kind: "resume", source: ERROR_RECOVERY_SOURCE, instruction: `${OUTPUT_CONTINUATION_INSTRUCTION} Previous tool calls all failed — reassess before re-issuing.` };
      });

      return () => {
        offEvents();
        offRequest();
        offConclude();
      };
    },
  } satisfies Plugin;
};
