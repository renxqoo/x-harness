// 摘要 side-call（docs/COMPACTION.md §1.1）：经 llmRuntime.stream 的旁路拨号。输入硬界
// 按摘要模型自己的窗口推导（挂账#4：不按主窗放行）；截头留尾；终态三分（stop 取全文/
// max-tokens 截断丢弃/error 软失败），abort 与看门狗静默；空闲看门狗防流静默挂死。

import type { LlmChunk, LlmFinish, LlmRuntime } from "@x-harness/llm";
import { WIDE_TOKENS_PER_CHAR } from "@x-harness/token-meter";
import { SUMMARIZATION_PROMPT, SUMMARIZATION_SYSTEM_PROMPT, UPDATE_SUMMARIZATION_PROMPT } from "./prompts.ts";
import { capSerializedConversation, neutralizeForSummary, neutralizeLineStarts } from "./serialize.ts";

export interface SummarizerFace {
  readonly model: string;
  readonly provider?: string;
  /** 摘要模型自己的窗口（输入硬界分母） */
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

const PROMPT_OVERHEAD_CHARS = 4_000;

/** 摘要输入字符上界：(摘要窗 − reserve − 固定开销 − 附加指令 − 上份摘要) / 上界费率；
 *  < 1 = 预算耗尽（调用方不拨号） */
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
  /** 已序列化、未截断的对话原文（截断与中和在本函数内完成） */
  readonly conversation: string;
  readonly previousSummary?: string;
  readonly customInstructions?: string;
  readonly signal: AbortSignal;
  /** 空闲看门狗毫秒；≤ 0 关闭 */
  readonly idleTimeoutMs: number;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}

/** 流消费结果：text 仅累计 text-delta（thinking 不计正文）；finish 缺席 = 适配器违约 */
interface Consumed {
  readonly text: string;
  readonly finish: LlmFinish | undefined;
  readonly aborted: boolean;
}

/** 空闲赛跑入参 */
interface RaceIdleFields<T> {
  readonly promise: Promise<T>;
  readonly ms: number;
  readonly onTimeout: () => void;
  /** 操作者/水位取消信号——纳入赛跑：适配器不感知 signal 时,取消不必等
   *  idleTimeoutMs 看门狗才收殓(REPL Ctrl+C 后最长 120s 假死的窗口)。生产恒在场 */
  readonly signal: AbortSignal;
}

/** 空闲赛跑：ms ≤ 0 直通；超时触发 onTimeout 后以 AbortError 拒绝（按取消路径收） */
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

/** 消费摘要流至终态：操作者取消与看门狗 → aborted（挂死跳过本轮，不告警不悬挂；
 *  尽力收殓迭代器——不信任适配器必然感知 signal）；其余异常 → failed */
/** 流消费入参 */
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
      return { text, finish: undefined, aborted: false }; // 非取消异常按 failed 结算（finish 缺席）
    }
    if (chunk.done) break;
    const value = chunk.value;
    if (value.type === "text-delta") text += value.text;
    else if (value.type === "finish") finish = value.finish;
  }
  if (aborted) {
    // 尽力收殓但不等待：生成器可能悬停于内部 await，return() 请求本身可能永不落定
    try {
      void iterator.return?.(undefined)?.catch(() => {});
    } catch {
      /* 收殓尽力而为——挂死流由看门狗与 signal 兜底 */
    }
  }
  return { text, finish, aborted };
}

/** 终态三分映射：stop 取全文（空 → empty）；max-tokens 截断丢弃（残缺摘要不得落账——
 *  replace 不可逆，会污染 previous-summary 链）；error 软失败 */
function outcomeOf(consumed: Consumed, parentAborted: boolean): SummarizeOutcome {
  if (consumed.aborted || parentAborted) return { ok: false, reason: "aborted" };
  const { finish, text } = consumed;
  if (finish === undefined) return { ok: false, reason: "failed" };
  if (finish.kind === "stop") return text.trim() === "" ? { ok: false, reason: "empty" } : { ok: true, text };
  if (finish.kind === "max-tokens") return { ok: false, reason: "truncated" };
  return { ok: false, reason: "failed" };
}

/** 会话原文 → 提示词：数据区包裹标签 + 上份摘要（累积更新）+ 结构化检查点指令 +
 *  附加聚焦。原文截头留尾后**再跑一遍行首破坏**（截头可切掉中和加的前导空格） */
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

/** 摘要拨号 + 流结算。系统提示词为常量（结构化检查点约束），输出上限 = face.maxOutputTokens */
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

/** 通用文本拨号 + 流结算（compaction 摘要与 autocompact CP 共用的单份流消费面：
 *  system 先行、空文本判 trim、截断丢弃、abort/看门狗静默、空闲收殓） */
export async function runTextRequest(input: {
  readonly llm: LlmRuntime;
  readonly face: SummarizerFace;
  readonly system: string;
  readonly prompt: string;
  readonly idleTimeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<SummarizeOutcome> {
  // 看门狗与父 signal 联动到本地 controller；监听器 finally 拆净
  const linked = new AbortController();
  const onParentAbort = (): void => linked.abort();
  if (input.signal.aborted) linked.abort();
  else input.signal.addEventListener("abort", onParentAbort, { once: true });
  let idle = false;
  try {
    const stream = input.llm.stream({
      model: input.face.model,
      ...(input.face.provider !== undefined ? { provider: input.face.provider } : {}),
      tools: [],
      // 系统提示词先行（不随对话漂移），pi 适配器从 system 角色消息装配
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
