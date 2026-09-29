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
  private readonly signatureParts: Array<{ signature: string; redacted: boolean }> = [];
  private readonly calls = new Map<number, ToolCallAccum>();
  private usage: TokenUsage | undefined;
  private finish: LlmFinish | undefined;

  push(chunk: LlmChunk): void {
    switch (chunk.type) {
      case "text-delta":
        this.textParts.push(chunk.text);
        break;
      case "thinking-delta":
        this.thinkingParts.push(chunk.text);
        break;
      case "thinking-signature":
        this.signatureParts.push({ signature: chunk.signature, redacted: chunk.redacted });
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

  get thinkingText(): string {
    return this.thinkingParts.join("");
  }

  get signatureBlocks(): ReadonlyArray<{ signature: string; redacted: boolean }> {
    return this.signatureParts;
  }

  get settledFinish(): LlmFinish | undefined {
    return this.finish;
  }

  get usageSnapshot(): TokenUsage | undefined {
    return this.usage;
  }

  get hasContent(): boolean {
    return this.text !== "" || this.calls.size > 0;
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

export type Settlement =
  | { readonly kind: "message"; readonly stopReason: "stop" | "max-tokens"; readonly rawReason?: string; readonly interrupted?: true }
  | { readonly kind: "attempt"; readonly error: string; readonly code?: string; readonly rawReason?: string; readonly retryAfterMs?: number };

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
      ...(finish.rawReason !== undefined ? { rawReason: finish.rawReason } : {}),
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
