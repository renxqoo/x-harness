// 工作错误恢复 L2 策略件（docs/WORK-ERROR-RECOVERY.md C5）：挂 agentRequestError +
// agentTurnConclude 双窗口。重试耗尽后的错误分族处置——可恢复族回模型自愈（respond），
// 分族连续 ×3 / 总连续 ×5 升 fail 收轮；任一工具成功或 assistant 正常 stop 清零。
// 装配契约：须注册在 llm-retry **之后**（链上后手）——retry 期本件应答被外层 retry 覆盖
// （不生效即不计数，防 L1 预烧 L2 预算）；耗尽后 llm-retry 让位，本件后手见事件。

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
  /** 分族连续失败上限（正整数缺省 3） */
  readonly maxConsecutiveFailures?: number;
  /** 不分族总连续失败上限（正整数缺省 5——封顶 429/network 交替循环） */
  readonly maxTotalFailures?: number;
  /** 族处置覆写（RETRY_POLICY retryableCodes 同款——宿主可纳 auth 过期进 respond 面） */
  readonly recoverableFamilies?: Readonly<Partial<Record<ErrorFamily, FamilyAction>>>;
}

/** respond 文案尾句（第二次起不再重复——首次告知自愈路径，达限即 fail 无文案面） */
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

/** requestError 纯决策（无副作用——计数写入 own）：死类（auth/context-overflow 已自愈）与
 *  skip 族（5xx/网络——L1 已退避耗尽，再 respond 只烧 token）直收 fail；达限（分族
 *  maxFamily / 总 maxTotal）fail；其余 respond（脱敏摘要 + 自愈指引）。 */
function decideRecovery(input: {
  readonly failure: RequestFailure;
  readonly own: Counters;
  readonly compactionHealed: () => boolean;
  readonly actions: Readonly<Record<ErrorFamily, FamilyAction>>;
  readonly maxFamily: number;
  readonly maxTotal: number;
}): RequestErrorDecision {
  const family = classifyFailure(input.failure.code);
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

      // 清零面：工具成功（isError 缺失）或 assistant 正常 stop——sessionEvent 同步观察面
      const offEvents = ctx.on(sessionEvent, ({ session, event }: { readonly session: SessionId; readonly event: SessionEvent }) => {
        if (event.type === "tool/result" && event.data.isError !== true) reset(session);
        else if (event.type === "assistant/message" && event.data.stopReason === "stop") reset(session);
      });

      const offRequest = ctx.on(agentRequestError, async (payload, next): Promise<RecoveryDecision> => {
        // 洋葱链外层（llm-retry）先 await next 再以 retry 覆盖：本件先调 next、只在自身
        // 应答真生效（downstream 让位 = 无外层覆盖）时计数——L1 重试期不预烧 L2 预算。
        // 下游异常吞为让位（llm-retry settleDownstream 同策——策略件不因下游崩而失效）
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
        if (session === undefined) return downstream; // 会话不可寻址 → 让位（不把读不到账本当零）
        return decideRecovery({
          failure: payload.failure,
          own: countersOf(payload.session),
          compactionHealed: () => hasCompactionLedger(session.events()),
          actions,
          maxFamily,
          maxTotal,
        });
      });

      // 收束窗口（经批 A 可达的带工具入口）：max-tokens + 上步工具结果全 isError → resume
      const offConclude = ctx.on(agentTurnConclude, async (payload, next): Promise<ConcludeDecision> => {
        const downstream = await next(payload);
        if (downstream !== undefined) return downstream; // agent-continuation 等已裁决 → 让位
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
