import type { Result } from "../../../../core/src/index";
export const llmErrorCodes = Object.freeze([
  "invalid-input",
  "unsupported-feature",
  "provider-not-found",
  "busy",
  "cancelled",
  "timeout",
  "authentication-failed",
  "permission-denied",
  "rate-limited",
  "context-overflow",
  "request-too-large",
  "network-error",
  "provider-error",
  "protocol-error",
  "invalid-output",
  "capacity-exceeded",
  "consumer-failed",
  "closed",
] as const);
export type LlmErrorCode = (typeof llmErrorCodes)[number];
export type LlmPhase =
  | "validation"
  | "admission"
  | "headers"
  | "stream"
  | "consumer"
  | "output"
  | "close";
export interface LlmError {
  readonly source: "llm";
  readonly code: LlmErrorCode;
  readonly phase: LlmPhase;
  readonly hasOutput: boolean;
  readonly status?: number;
  readonly providerCode?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
}
export type LlmResult<T> = Result<T, LlmError>;
