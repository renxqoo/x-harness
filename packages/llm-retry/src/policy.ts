export interface RetryPolicy {
  readonly maxRetries: number;
  readonly retryableCodes?: readonly string[];
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
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
