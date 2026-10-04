import type { SurfaceNode } from "@x-harness/session";
import { serializeConversation } from "./serialize.ts";
import { summaryInputMaxChars, scaledIdleMs, summarize } from "./summarize.ts";
import type { SummarizerFace, SummarizeOutcome } from "./summarize.ts";
import type { LlmRuntime } from "@x-harness/llm";

export interface FoldedInput {
  readonly llm: LlmRuntime;
  readonly face: SummarizerFace;
  readonly reserveTokens: number;
  readonly nodes: readonly SurfaceNode[];
  readonly previousSummary?: string;
  readonly customInstructions?: string;
  readonly signal: AbortSignal;
}

export function segmentNodes(nodes: readonly SurfaceNode[], maxChars: number): readonly string[] {
  const chunks: string[] = [];
  let current: SurfaceNode[] = [];
  let currentChars = 0;
  for (const node of nodes) {
    const text = serializeConversation([node]);
    const weight = text.length + 2;
    if (current.length > 0 && currentChars + weight > maxChars) {
      chunks.push(serializeConversation(current));
      current = [];
      currentChars = 0;
    }
    current.push(node);
    currentChars += weight;
  }
  if (current.length > 0) chunks.push(serializeConversation(current));
  return chunks;
}

export async function summarizeFolded(input: FoldedInput): Promise<SummarizeOutcome> {
  const segmentBudget = segmentBudgetOf(input);
  if (segmentBudget < 1) return { ok: false, reason: "budget-exhausted" };
  const chunks = segmentNodes(input.nodes, segmentBudget);
  if (chunks.length === 0) return { ok: false, reason: "empty" };
  let rolling: string | undefined = input.previousSummary;
  for (const chunk of chunks) {
    const perCall = summaryInputMaxChars({
      face: input.face,
      reserveTokens: input.reserveTokens,
      ...(rolling !== undefined ? { previousSummary: rolling } : {}),
      ...(input.customInstructions !== undefined ? { customInstructions: input.customInstructions } : {}),
    });
    if (perCall < 1) return { ok: false, reason: "budget-exhausted" };
    const trimmed = chunk.length > perCall ? chunk.slice(0, perCall) : chunk;
    const outcome = await summarize({
      llm: input.llm,
      face: input.face,
      reserveTokens: input.reserveTokens,
      conversation: trimmed,
      ...(rolling !== undefined ? { previousSummary: rolling } : {}),
      ...(input.customInstructions !== undefined ? { customInstructions: input.customInstructions } : {}),
      signal: input.signal,
      idleTimeoutMs: scaledIdleMs(trimmed.length),
    });
    if (!outcome.ok) return outcome;
    rolling = outcome.text;
  }
  return rolling === undefined ? { ok: false, reason: "empty" } : { ok: true, text: rolling };
}

function segmentBudgetOf(input: FoldedInput): number {
  const overheadGuess = 2_048;
  return Math.max(0, summaryInputMaxChars({
    face: input.face,
    reserveTokens: input.reserveTokens,
    ...(input.customInstructions !== undefined ? { customInstructions: input.customInstructions } : {}),
  }) - overheadGuess);
}
