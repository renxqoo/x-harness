import type { LlmChunk, LlmFinish, LlmRuntime } from "@x-harness/llm";
import { WIDE_TOKENS_PER_CHAR } from "@x-harness/token-meter";
import { SUMMARIZATION_PROMPT, SUMMARIZATION_SYSTEM_PROMPT, UPDATE_SUMMARIZATION_PROMPT } from "./prompts.ts";
import { capSerializedConversation, neutralizeForSummary, neutralizeLineStarts } from "./serialize.ts";

export interface SummarizerFace {
  readonly model: string;
  readonly provider?: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

const PROMPT_OVERHEAD_CHARS = 4_000;

export function summaryInputMaxChars(fields: {
  readonly face: SummarizerFace;
  readonly reserveTokens: number;
  readonly previousSummary?: string;
  readonly customInstructions?: string;
}): number {
  const overhead = PROMPT_OVERHEAD_CHARS + (fields.previousSummary?.length ?? 0) + (fields.customInstructions?.length ?? 0);
  return Math.floor((fields.face.contextWindow - fields.reserveTokens - overhead) / WIDE_TOKENS_PER_CHAR);
}

export type SummarizeOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "budget-exhausted" | "truncated" | "empty" | "failed" | "aborted" };

export interface SummarizeInput {
  readonly llm: LlmRuntime;
  readonly face: SummarizerFace;
  readonly reserveTokens: number;
  readonly conversation: string;
  readonly previousSummary?: string;
  readonly customInstructions?: string;
  readonly signal: AbortSignal;
  readonly idleTimeoutMs: number;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}

interface Consumed {
  readonly text: string;
  readonly finish: LlmFinish | undefined;
  readonly aborted: boolean;
}

interface RaceIdleFields<T> {
  readonly promise: Promise<T>;
  readonly ms: number;
  readonly onTimeout: () => void;
  readonly signal: AbortSignal;
}

async function raceIdle<T>(fields: RaceIdleFields<T>): Promise<T> {
  const { promise, ms, onTimeout, signal } = fields;
  if (ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let offAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new DOMException("summarize idle", "AbortError"));
        }, ms);
        if (signal.aborted) {
          reject(new DOMException("summarize aborted", "AbortError"));
          return;
        }
        const onAbort = () => reject(new DOMException("summarize aborted", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        offAbort = () => signal.removeEventListener("abort", onAbort);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    offAbort?.();
  }
}

interface ConsumeFields {
  readonly iterator: AsyncIterator<LlmChunk>;
  readonly idleTimeoutMs: number;
  readonly onIdle: () => void;
  readonly signal: AbortSignal;
}

async function consumeSummarizeStream(fields: ConsumeFields): Promise<Consumed> {
  const { iterator, idleTimeoutMs, onIdle, signal } = fields;
  let text = "";
  let finish: LlmFinish | undefined;
  let aborted = false;
  for (;;) {
    let chunk: IteratorResult<LlmChunk>;
    try {
      chunk = await raceIdle({ promise: iterator.next(), ms: idleTimeoutMs, onTimeout: onIdle, signal });
    } catch (error) {
      if (isAbortLike(error)) {
        aborted = true;
        break;
      }
      return { text, finish: undefined, aborted: false };
    }
    if (chunk.done) break;
    const value = chunk.value;
    if (value.type === "text-delta") text += value.text;
    else if (value.type === "finish") finish = value.finish;
  }
  if (aborted) {
    try {
      void iterator.return?.(undefined)?.catch(() => {});
    } catch {
    }
  }
  return { text, finish, aborted };
}

function outcomeOf(consumed: Consumed, parentAborted: boolean): SummarizeOutcome {
  if (consumed.aborted || parentAborted) return { ok: false, reason: "aborted" };
  const { finish, text } = consumed;
  if (finish === undefined) return { ok: false, reason: "failed" };
  if (finish.kind === "stop") return text.trim() === "" ? { ok: false, reason: "empty" } : { ok: true, text };
  if (finish.kind === "max-tokens") return { ok: false, reason: "truncated" };
  return { ok: false, reason: "failed" };
}

export function buildSummarizePrompt(input: {
  readonly conversation: string;
  readonly maxChars: number;
  readonly previousSummary?: string;
  readonly customInstructions?: string;
}): string {
  const conversation = neutralizeLineStarts(capSerializedConversation(input.conversation, input.maxChars));
  const sections = [`<conversation>\n${conversation}\n</conversation>`];
  if (input.previousSummary !== undefined) {
    sections.push(`<previous-summary>\n${neutralizeForSummary(input.previousSummary)}\n</previous-summary>`);
  }
  const base = input.previousSummary !== undefined ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  const focus = input.customInstructions !== undefined ? `\n\nAdditional focus: ${input.customInstructions}` : "";
  return `${sections.join("\n\n")}\n\n${base}${focus}`;
}

export async function summarize(input: SummarizeInput): Promise<SummarizeOutcome> {
  const maxChars = summaryInputMaxChars(input);
  if (maxChars < 1) return { ok: false, reason: "budget-exhausted" };
  const prompt = buildSummarizePrompt({
    conversation: input.conversation,
    maxChars,
    ...(input.previousSummary !== undefined ? { previousSummary: input.previousSummary } : {}),
    ...(input.customInstructions !== undefined ? { customInstructions: input.customInstructions } : {}),
  });
  return runTextRequest({
    llm: input.llm,
    face: input.face,
    system: SUMMARIZATION_SYSTEM_PROMPT,
    prompt,
    idleTimeoutMs: input.idleTimeoutMs,
    signal: input.signal,
  });
}

export async function runTextRequest(input: {
  readonly llm: LlmRuntime;
  readonly face: SummarizerFace;
  readonly system: string;
  readonly prompt: string;
  readonly idleTimeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<SummarizeOutcome> {
  const linked = new AbortController();
  const onParentAbort = (): void => linked.abort();
  if (input.signal.aborted) linked.abort();
  else input.signal.addEventListener("abort", onParentAbort, { once: true });
  let idle = false;
  try {
    const stream = input.llm.stream({
      model: input.face.model,
      ...(input.face.provider !== undefined ? { provider: input.face.provider } : {}),
      session: "internal:summarizer" as never,
      tools: [],
      messages: [
        { role: "system", text: input.system },
        { role: "user", content: [{ type: "text", text: input.prompt }] },
      ],
      maxTokens: input.face.maxOutputTokens,
      signal: linked.signal,
    });
    const consumed = await consumeSummarizeStream({
      iterator: stream[Symbol.asyncIterator](),
      idleTimeoutMs: input.idleTimeoutMs,
      onIdle: () => {
        idle = true;
        linked.abort();
      },
      signal: input.signal,
    });
    return outcomeOf(consumed, input.signal.aborted || idle);
  } finally {
    input.signal.removeEventListener("abort", onParentAbort);
  }
}

export { SUMMARIZATION_SYSTEM_PROMPT };
