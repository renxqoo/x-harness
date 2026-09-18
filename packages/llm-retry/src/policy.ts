// 重试策略与退避计算（docs/LLM-RETRY.md §1）：指数退避+抖动（抖动后硬封顶）、Retry-After 快车道、
// 定时器域上限（setTimeout 溢出阈值 2^31-1——超限被钳成 1ms 立即触发，退避会变轰击）。

export interface RetryPolicy {
  /** ≥0；0 = 不重试（只审计） */
  readonly maxRetries: number;
  /** 缺省集：瞬时网络类与限流/网关类 */
  readonly retryableCodes?: readonly string[];
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** [0,1]；0 = 无抖动 */
  readonly jitterRatio: number;
}

export const DEFAULT_RETRYABLE_CODES: readonly string[] = [
  "http-408",
  "http-429",
  "http-500",
  "http-502",
  "http-503",
  "http-504",
  "network",
];

/** setTimeout 的 delay 域上限（协议事实：超限被实现钳制为 1ms 立即触发） */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

type FieldCheck = readonly [ok: boolean, detail: string];

const isCount = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value);

function policyChecks(policy: RetryPolicy): readonly FieldCheck[] {
  return [
    [isCount(policy?.maxRetries) && policy.maxRetries >= 0, "maxRetries must be a non-negative integer"],
    [isCount(policy?.initialDelayMs) && policy.initialDelayMs > 0 && policy.initialDelayMs <= MAX_TIMER_DELAY_MS, `initialDelayMs must be in (0, ${String(MAX_TIMER_DELAY_MS)}]`],
    [isCount(policy?.maxDelayMs) && policy.maxDelayMs >= (policy?.initialDelayMs ?? 0) && policy.maxDelayMs <= MAX_TIMER_DELAY_MS, `maxDelayMs must be >= initialDelayMs and <= ${String(MAX_TIMER_DELAY_MS)}`],
    [isCount(policy?.jitterRatio) && policy.jitterRatio >= 0 && policy.jitterRatio <= 1, "jitterRatio must be within [0, 1]"],
    [isValidCodes(policy?.retryableCodes), "retryableCodes must be non-empty strings"],
  ];
}

export function validatePolicy(policy: RetryPolicy, origin: string): void {
  const bad = (detail: string): Error => new Error(`llm-retry: invalid ${origin} policy: ${detail}`);
  for (const [ok, detail] of policyChecks(policy)) {
    if (!ok) throw bad(detail);
  }
}

function isValidCodes(codes: readonly string[] | undefined): boolean {
  const list = codes ?? DEFAULT_RETRYABLE_CODES;
  return Array.isArray(list) && list.every((code) => typeof code === "string" && code !== "");
}

/**
 * 退避延迟：failure.retryAfterMs ≤ maxDelayMs → 原样采用（0 合法=立即重试）；
 * 超上限 → undefined（放弃重试）；否则 initial×2^(retry-1)×抖动 [1-ratio,1+ratio] 后 min 硬封顶。
 */
export interface BackoffInput {
  readonly policy: RetryPolicy;
  readonly retry: number;
  readonly retryAfterMs: number | undefined;
  readonly random: () => number;
}

export function backoffDelay(input: BackoffInput): number | undefined {
  const { policy, retry, retryAfterMs, random } = input;
  if (retryAfterMs !== undefined) {
    return retryAfterMs <= policy.maxDelayMs ? retryAfterMs : undefined;
  }
  const exponent = Math.min(retry - 1, 1024);
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs);
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random();
  return Math.min(exponential * jitter, policy.maxDelayMs);
}

/** 可取消等待：到点 → true；signal 断 → false（监听器拆净，无定时器泄漏） */
export function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    function onAbort(): void {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
