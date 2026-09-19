// 拨号底座（docs/LLM.md §1.5 共享件）：fetch + 连接失败/非 2xx 映射 + Retry-After 解析。
// 协议无关——URL/headers/body 归消费方；失败映射与 Retry-After 是最易漂移的纯逻辑，禁止第二份。

import type { LlmChunk } from "./types.ts";

export interface DialInput {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly signal: AbortSignal;
  readonly fetch: typeof fetch;
}

export type DialResult = { readonly response: Response } | { readonly failure: LlmChunk };

/** Retry-After：秒（含小数）→ 毫秒；HTTP-date → 相对毫秒（过去=0 立即）；不可解析 → undefined（缺席） */
export function parseRetryAfterMs(header: string | null, now: () => number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - now());
}

export async function dial(input: DialInput): Promise<DialResult> {
  try {
    const response = await input.fetch(input.url, {
      method: "POST",
      // SSE 恒不协商压缩：运行时默认 accept-encoding 会换来无逐块 flush 的 gzip/br，
      // 透明解压把流攒成大坨（本地实验复现：8ms/帧平滑流 → 全部挤在流末一坨）
      headers: { ...input.headers, "accept-encoding": "identity" },
      body: JSON.stringify(input.body),
      signal: input.signal,
    });
    if (response.ok && response.body !== null) return { response };
    const body = response.body === null ? "" : await response.text().catch(() => "");
    const status = String(response.status);
    const retry = response.status === 429 || response.status === 503 ? parseRetryAfterMs(response.headers.get("retry-after"), Date.now) : undefined;
    return {
      failure: {
        type: "finish",
        finish: {
          kind: "error",
          message: body.slice(0, 200), // code 已携带状态；message 只给体摘要
          code: `http-${status}`,
          ...(retry !== undefined ? { retryAfterMs: retry } : {}),
        },
      },
    };
  } catch (error) {
    if (input.signal.aborted) throw error; // abort 豁免：透传 AbortError
    return { failure: { type: "finish", finish: { kind: "error", message: errorMessage(error), code: "network" } } };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
