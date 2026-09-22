// 流累积与结算（docs/AGENT-LOOP-DRIVER.md §1.4）：text-delta 拼接、thinking-delta 拼接
// （落盘收集——docs/STREAM-PARTIAL-PERSISTENCE.md，回传面仍不投影）、tool-call-delta 按
// index 聚积、usage 捕获、finish 三态；结算判定（message / attempt / 空）。

import type { ContentBlock } from "@x-harness/session";
import type { LlmChunk, LlmFinish, TokenUsage } from "@x-harness/llm";

interface ToolCallAccum {
  callId: string;
  name: string;
  argumentsParts: string[];
}

export class StreamAccumulator {
  private readonly textParts: string[] = [];
  private readonly thinkingParts: string[] = [];
  private readonly calls = new Map<number, ToolCallAccum>();
  private usage: TokenUsage | undefined;
  private finish: LlmFinish | undefined;

  push(chunk: LlmChunk): void {
    switch (chunk.type) {
      case "text-delta":
        this.textParts.push(chunk.text);
        break;
      case "thinking-delta":
        this.thinkingParts.push(chunk.text); // 落账收集（docs/STREAM-PARTIAL-PERSISTENCE.md——回传面仍不投影）
        break;
      case "tool-call-delta": {
        const existing = this.calls.get(chunk.index);
        if (existing === undefined) {
          this.calls.set(chunk.index, {
            callId: chunk.callId ?? `call-${String(chunk.index)}`,
            name: chunk.name ?? "",
            argumentsParts: chunk.argumentsDelta !== undefined ? [chunk.argumentsDelta] : [],
          });
        } else {
          if (chunk.callId !== undefined) existing.callId = chunk.callId;
          if (chunk.name !== undefined) existing.name = chunk.name;
          if (chunk.argumentsDelta !== undefined) existing.argumentsParts.push(chunk.argumentsDelta);
        }
        break;
      }
      case "usage":
        this.usage = chunk.usage;
        break;
      case "finish":
        this.finish = chunk.finish;
        break;
    }
  }

  get text(): string {
    return this.textParts.join("");
  }

  /** 本 attempt 思考全文（增量拼接；无思考=空串）——落盘专用，空结算判定不含思考 */
  get thinkingText(): string {
    return this.thinkingParts.join("");
  }

  get settledFinish(): LlmFinish | undefined {
    return this.finish;
  }

  get usageSnapshot(): TokenUsage | undefined {
    return this.usage;
  }

  get hasContent(): boolean {
    return this.text !== "" || this.calls.size > 0; // 拼接后判空——零宽帧（replay-guard 保活）不计内容
  }

  get toolUseBlocks(): ContentBlock[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({ type: "tool_use" as const, callId: call.callId, name: call.name, input: call.argumentsParts.join("") }));
  }

  get textBlock(): ContentBlock[] {
    return this.text === "" ? [] : [{ type: "text" as const, text: this.text }];
  }
}

/** 流空闲看门狗赛跑：idleMs ≤0 直通；超时以 timedOut 哨兵解决（不抛——取消语义独占，
 *  超时注入 finish 的路径在消费方）。败者收殓：超时路径的 pending 随后可能因 abort 传导
 *  而拒绝，附挂 catch 防悬空 rejection */
type IdleRace<T> = { readonly timedOut: true } | { readonly timedOut: false; readonly value: T };

export async function raceIdleChunk<T>(pending: Promise<T>, idleMs: number): Promise<IdleRace<T>> {
  if (idleMs <= 0) return { timedOut: false, value: await pending };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ readonly timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), idleMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    pending.catch(() => {});
  }
}

/** 结算判定：message（stop/max-tokens，或有内容的 abort）/ attempt（错误、空完成、无 finish 流）。
 *  attempt 携 code/retryAfterMs 透传给 RequestFailure——重试件的可重试判定与快车道输入。
 *  message 携 rawReason（provider 原生 stop reason——收束窗口载荷的诊断与判定输入）。 */
export type Settlement =
  | { readonly kind: "message"; readonly stopReason: "stop" | "max-tokens"; readonly rawReason?: string; readonly interrupted?: true }
  | { readonly kind: "attempt"; readonly error: string; readonly code?: string; readonly retryAfterMs?: number };

export function settleStream(accum: StreamAccumulator, streamThrew: unknown, signalAborted: boolean): Settlement {
  if (streamThrew !== undefined) {
    if (signalAborted && accum.hasContent) return { kind: "message", stopReason: "stop", interrupted: true };
    return { kind: "attempt", error: normalizeFailure(streamThrew) };
  }
  const finish = accum.settledFinish;
  if (finish === undefined) return { kind: "attempt", error: "stream ended without finish", code: "network" };
  if (finish.kind === "error") {
    return {
      kind: "attempt",
      error: `${finish.code !== undefined ? `${finish.code}:` : ""}${finish.message}`,
      ...(finish.code !== undefined ? { code: finish.code } : {}),
      ...(finish.retryAfterMs !== undefined ? { retryAfterMs: finish.retryAfterMs } : {}),
    };
  }
  if (finish.kind === "max-tokens") {
    return { kind: "message", stopReason: "max-tokens", ...(finish.rawReason !== undefined ? { rawReason: finish.rawReason } : {}) };
  }
  if (!accum.hasContent) return { kind: "attempt", error: "empty completion" };
  return { kind: "message", stopReason: "stop" };
}

function normalizeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
