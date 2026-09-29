import type { TurnConcludeDecision } from "@x-harness/agent-loop";

export const OUTPUT_CONTINUATION_INSTRUCTION =
  "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";

export const OUTPUT_CONTINUATION_SOURCE = "output-continuation";

export const GIVE_UP: Extract<TurnConcludeDecision, { kind: "fail" }> = {
  kind: "fail",
  message: "The model's response exceeded the output token maximum.",
  code: "output-token-limit",
};

export const DEFAULT_MAX_OUTPUT_CONTINUATIONS = 3;

export interface ContinuationDecideInput {
  readonly stopReason: "stop" | "max-tokens";
  readonly content: readonly unknown[];
  readonly hasThinking?: true;
  readonly hasTools?: boolean;
  readonly truncatedCount?: number;
  readonly signal: AbortSignal;
  readonly count: number;
  readonly max: number;
}

export function decideContinuation(input: ContinuationDecideInput): TurnConcludeDecision | undefined {
  if (input.signal.aborted) return undefined;
  if (input.stopReason !== "max-tokens") return undefined;
  if (input.hasTools === true) return undefined;
  if (input.content.length === 0 && input.hasThinking !== true) return undefined;
  if (input.count < input.max) {
    return { kind: "resume", source: OUTPUT_CONTINUATION_SOURCE, instruction: OUTPUT_CONTINUATION_INSTRUCTION };
  }
  return GIVE_UP;
}

export function validateMaxOutputContinuations(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_OUTPUT_CONTINUATIONS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`maxOutputContinuations must be a non-negative integer (got ${String(value)})`);
  }
  return value;
}
