// 流累积与结算（docs/AGENT-LOOP-DRIVER.md §1.4）：text-delta 拼接、tool-call-delta 按 index 聚积、
// usage 捕获、finish 三态；结算判定（message / attempt / 空）。

import type { ContentBlock } from "@x-harness/session";
import type { LlmChunk, LlmFinish, TokenUsage } from "@x-harness/llm";

interface ToolCallAccum {
  callId: string;
  name: string;
  argumentsParts: string[];
}

export class StreamAccumulator {
  private readonly textParts: string[] = [];
  private readonly calls = new Map<number, ToolCallAccum>();
  private usage: TokenUsage | undefined;
  private finish: LlmFinish | undefined;

  push(chunk: LlmChunk): void {
    switch (chunk.type) {
      case "text-delta":
        this.textParts.push(chunk.text);
        break;
      case "thinking-delta":
        break; // 思考只走流帧广播，不落账、不救空结算（docs/THINKING-STREAM.md 契约 5）
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

  get settledFinish(): LlmFinish | undefined {
    return this.finish;
  }

  get usageSnapshot(): TokenUsage | undefined {
    return this.usage;
  }

  get hasContent(): boolean {
    return this.textParts.length > 0 || this.calls.size > 0;
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

/** 结算判定：message（stop/max-tokens，或有内容的 abort）/ attempt（错误、空完成、无 finish 流）。
 *  attempt 携 code/retryAfterMs 透传给 RequestFailure——重试件的可重试判定与快车道输入 */
export type Settlement =
  | { readonly kind: "message"; readonly stopReason: "stop" | "max-tokens"; readonly interrupted?: true }
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
  if (finish.kind === "max-tokens") return { kind: "message", stopReason: "max-tokens" };
  if (!accum.hasContent) return { kind: "attempt", error: "empty completion" };
  return { kind: "message", stopReason: "stop" };
}

function normalizeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
