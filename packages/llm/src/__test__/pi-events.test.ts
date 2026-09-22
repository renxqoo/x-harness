// pi-events 映射矩阵（docs/LLM-PI.md 测试口径）：事件族全量、P10 初值、toolcall 三形态、
// usage 折算与全零守卫、终态恰一次、abort rethrow、错误分类负例、防御层。

import { describe, expect, it } from "vitest";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { classifyErrorText, foldUsage, piChunks } from "../pi-events.ts";
import type { LlmChunk } from "../types.ts";

const idleSignal = (): AbortSignal => new AbortController().signal;
const noFailure = (): { status?: number; retryAfterMs?: number } => ({});

function assistantEvent(fields: Record<string, unknown>): AssistantMessageEvent {
  return {
    partial: { role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timestamp: 0 },
    ...fields,
  } as never;
}

function doneEvent(): AssistantMessageEvent {
  return assistantEvent({ type: "done", reason: "stop", message: { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }) as never;
}

async function collect(
  events: AssistantMessageEvent[],
  options?: { signal?: AbortSignal; failureInfo?: () => { status?: number; retryAfterMs?: number }; emitStartInitials?: boolean },
): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  const iterable = {
    [Symbol.asyncIterator]: (): AsyncIterator<AssistantMessageEvent> => {
      let i = 0;
      return { next: async () => (i < events.length ? { done: false, value: events[i++] as AssistantMessageEvent } : { done: true as const, value: undefined }) };
    },
  };
  for await (const chunk of piChunks(iterable, {
    signal: options?.signal ?? idleSignal(),
    failureInfo: options?.failureInfo ?? noFailure,
    ...(options?.emitStartInitials !== undefined ? { emitStartInitials: options.emitStartInitials } : {}),
  })) {
    out.push(chunk);
  }
  return out;
}

describe("piChunks 事件矩阵（docs/LLM-PI.md 契约 2）", () => {
  it("P10 初值（emitStartInitials=true，anthropic 方言）：start 非空初值补发 delta；空 delta 跳过；关闭时不读 partial", async () => {
    const chunks = await collect(
      [
        assistantEvent({ type: "thinking_start", contentIndex: 0, partial: { content: [{ type: "thinking", thinking: "思" }] } }),
        assistantEvent({ type: "thinking_delta", contentIndex: 0, delta: "" }), // 空 delta 跳过
        assistantEvent({ type: "thinking_delta", contentIndex: 0, delta: "考" }),
        assistantEvent({ type: "thinking_end", contentIndex: 0, content: "思考" }),
        assistantEvent({ type: "text_start", contentIndex: 1, partial: { content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "he" }] } }),
        assistantEvent({ type: "text_delta", contentIndex: 1, delta: "llo" }),
        assistantEvent({ type: "text_end", contentIndex: 1, content: "hello" }),
        doneEvent(),
      ],
      { emitStartInitials: true },
    );
    expect(chunks).toEqual([
      { type: "thinking-delta", text: "思" },
      { type: "thinking-delta", text: "考" },
      { type: "text-delta", text: "he" },
      { type: "text-delta", text: "llo" },
      { type: "finish", finish: { kind: "stop" } },
    ]);
    // openai 方言（emitStartInitials 缺省 false）：start 不读 partial（pi 同步块已变异），只透传 delta
    const openai = await collect([
      assistantEvent({ type: "text_start", contentIndex: 0, partial: { content: [{ type: "text", text: "he" }] } }),
      assistantEvent({ type: "text_delta", contentIndex: 0, delta: "he" }),
      assistantEvent({ type: "text_delta", contentIndex: 0, delta: "llo" }),
      assistantEvent({ type: "text_end", contentIndex: 0, content: "hello" }),
      doneEvent(),
    ]);
    expect(openai).toEqual([
      { type: "text-delta", text: "he" },
      { type: "text-delta", text: "llo" },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("终态校正：wire 尾段未被 delta 覆盖时补发（text_end/thinking_end）", async () => {
    const chunks = await collect([
      assistantEvent({ type: "text_start", contentIndex: 0, partial: { content: [] } }),
      assistantEvent({ type: "text_delta", contentIndex: 0, delta: "hel" }),
      assistantEvent({ type: "text_end", contentIndex: 0, content: "hello" }), // 尾段 "lo" 缺
      doneEvent(),
    ]);
    expect(chunks).toEqual([
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo" }, // 补发缺失尾段
      { type: "finish", finish: { kind: "stop" } },
    ]);
    // 非前缀关系（超发/乱序）不强行校正
    const mismatch = await collect([
      assistantEvent({ type: "text_start", contentIndex: 0, partial: { content: [] } }),
      assistantEvent({ type: "text_delta", contentIndex: 0, delta: "xyz" }),
      assistantEvent({ type: "text_end", contentIndex: 0, content: "hello" }),
      doneEvent(),
    ]);
    expect(mismatch).toEqual([{ type: "text-delta", text: "xyz" }, { type: "finish", finish: { kind: "stop" } }]);
  });

  it("toolcall 出口单帧：start/delta 分片不透传，end 发一帧完整调用（全量 JSON 文本）", async () => {
    const chunks = await collect([
      assistantEvent({ type: "toolcall_start", contentIndex: 1, partial: { content: [{ type: "text", text: "a" }, { type: "toolCall", id: "t1", name: "add" }] } }),
      assistantEvent({ type: "toolcall_delta", contentIndex: 1, delta: '{"a"' }),
      assistantEvent({ type: "toolcall_delta", contentIndex: 1, delta: ":1}" }),
      assistantEvent({ type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "t1", name: "add", arguments: { a: 1 } } }),
      assistantEvent({ type: "toolcall_start", contentIndex: 2, partial: { content: [] } }), // openai 无身份方言同样收敛到 end
      assistantEvent({ type: "toolcall_delta", contentIndex: 2, delta: '{"b":2}' }),
      assistantEvent({ type: "toolcall_end", contentIndex: 2, toolCall: { type: "toolCall", id: "t2", name: "sub", arguments: { b: 2 } } }),
      doneEvent(),
    ]);
    expect(chunks).toEqual([
      { type: "tool-call-delta", index: 1, callId: "t1", name: "add", argumentsDelta: '{"a":1}' },
      { type: "tool-call-delta", index: 2, callId: "t2", name: "sub", argumentsDelta: '{"b":2}' },
      { type: "finish", finish: { kind: "stop" } },
    ]);
  });

  it("done：usage cache 桶折入 input、恰形两键；length→max-tokens；toolUse/deferred→stop；终态恰一次", async () => {
    const usage = { input: 10, output: 7, cacheRead: 5, cacheWrite: 2 };
    for (const reason of ["stop", "toolUse", "deferred"] as const) {
      const chunks = await collect([assistantEvent({ type: "done", reason, message: { usage } })]);
      expect(chunks).toEqual([{ type: "usage", usage: { input: 17, output: 7, cacheRead: 5, cacheWrite: 2 } }, { type: "finish", finish: { kind: "stop" } }]);
    }
    expect(await collect([assistantEvent({ type: "done", reason: "length", message: { usage } })])).toEqual([
      { type: "usage", usage: { input: 17, output: 7, cacheRead: 5, cacheWrite: 2 } },
      { type: "finish", finish: { kind: "max-tokens" } },
    ]);
    // 终态恰一次：done 后的多余事件不产 chunk（finish 恰一帧且为末帧）
    const extra = await collect([
      assistantEvent({ type: "done", reason: "stop", message: { usage } }),
      assistantEvent({ type: "text_delta", contentIndex: 0, delta: "late" }),
    ]);
    expect(extra.filter((c) => c.type === "finish")).toHaveLength(1);
    expect(extra.at(-1)?.type).toBe("finish");
    // 反方向：error 后 pi 违约补 done——仍恰一 finish 且为末帧
    const afterError = await collect([
      assistantEvent({ type: "error", reason: "error", error: { errorMessage: "x" } }),
      doneEvent(),
    ]);
    expect(afterError.filter((c) => c.type === "finish")).toHaveLength(1);
    expect(afterError.at(-1)?.type).toBe("finish");
  });

  it("usage 全零守卫：缺报后端不产噪音帧；foldUsage 直接断言", () => {
    expect(foldUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toEqual([]);
    expect(foldUsage(undefined)).toEqual([]);
    expect(foldUsage({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 })).toEqual([{ type: "usage", usage: { input: 1, output: 0 } }]); // 零 cache 不透传
  });

  it("error：usage 先行（失败尝试计费）→ 状态码在场落 http-<status> + retryAfterMs 透传", async () => {
    const chunks = await collect([assistantEvent({ type: "error", reason: "error", error: { usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 }, errorMessage: "rate limited" } })], {
      failureInfo: () => ({ status: 429, retryAfterMs: 2500 }),
    });
    expect(chunks).toEqual([
      { type: "usage", usage: { input: 3, output: 4 } },
      { type: "finish", finish: { kind: "error", message: "rate limited", code: "http-429", retryAfterMs: 2500 } },
    ]);
  });

  it("回归：refusal 真身文案（\"The model refused…\"）与 rawStopReason 均落无 code 不可重试", async () => {
    // pi 真身文案不含 "refusal" 子串（含 "refused"）——旧词表匹配曾漏判落 network 可重试
    const byText = await collect([
      assistantEvent({ type: "error", reason: "error", error: { errorMessage: "The model refused to complete the request" } }),
    ]);
    expect(byText).toEqual([
      { type: "finish", finish: { kind: "error", message: "The model refused to complete the request" } },
    ]);
    // rawStopReason 判定优先于文案分类与已捕获状态码
    const byRaw = await collect([assistantEvent({ type: "error", reason: "error", error: { errorMessage: "anything", rawStopReason: "refusal" } })], {
      failureInfo: () => ({ status: 500 }),
    });
    expect(byRaw).toEqual([{ type: "finish", finish: { kind: "error", message: "anything" } }]);
  });

  it("未知 stop_reason 口径锁定：pi 对未知 reason 折 \"Unhandled stop reason\" 错误 → network（语义变更，docs/LLM-PI.md）", async () => {
    expect(classifyErrorText("Unhandled stop reason: brand_new")).toBe("network");
    expect(
      await collect([assistantEvent({ type: "error", reason: "error", error: { errorMessage: "Unhandled stop reason: brand_new" } })]),
    ).toEqual([{ type: "finish", finish: { kind: "error", message: "Unhandled stop reason: brand_new", code: "network" } }]);
  });

  it("error：无状态码走文案分类（network/无 code）；未知事件跳过；防御层流耗尽→network", async () => {
    expect(await collect([assistantEvent({ type: "error", reason: "error", error: { errorMessage: "Connection error." } })])).toEqual([
      { type: "finish", finish: { kind: "error", message: "Connection error.", code: "network" } },
    ]);
    expect(await collect([assistantEvent({ type: "error", reason: "error", error: { errorMessage: "request refusal" } })])).toEqual([
      { type: "finish", finish: { kind: "error", message: "request refusal" } }, // 无 code 不可重试
    ]);
    expect(await collect([{ type: "mystery" } as never])).toEqual([
      { type: "finish", finish: { kind: "error", message: "stream ended without finish", code: "network" } },
    ]);
  });

  it("abort 豁免：reason aborted / signal 已断 → throw AbortError（不产 error finish）", async () => {
    await expect(collect([assistantEvent({ type: "error", reason: "aborted", error: {} })])).rejects.toThrow("aborted");
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect([assistantEvent({ type: "error", reason: "error", error: { errorMessage: "x" } })], { signal: controller.signal }),
    ).rejects.toThrow("aborted");
  });
});

describe("截断信号归一（docs/OUTPUT-TOKEN-CONTINUATION.md 批1：done 透传 / error 救回 / overflow 分类）", () => {
  it("done：length → max-tokens 透传 rawReason 三态；无 rawStopReason 字段缺席", async () => {
    for (const raw of ["max_tokens", "length", "incomplete.max_output_tokens"]) {
      expect(await collect([assistantEvent({ type: "done", reason: "length", message: { rawStopReason: raw } })])).toEqual([
        { type: "finish", finish: { kind: "max-tokens", rawReason: raw } },
      ]);
    }
    expect(await collect([assistantEvent({ type: "done", reason: "length", message: {} })])).toEqual([
      { type: "finish", finish: { kind: "max-tokens" } },
    ]);
  });

  it("error 救回：rawStopReason ∈ 三词表 + 流内有 text 内容 → max-tokens 终态（partial 先行保留）", async () => {
    for (const raw of ["max_tokens", "max_output_tokens", "model_context_window_exceeded"]) {
      expect(
        await collect([
          assistantEvent({ type: "text_start", contentIndex: 0, partial: { content: [] } }),
          assistantEvent({ type: "text_delta", contentIndex: 0, delta: "half " }),
          assistantEvent({ type: "error", reason: "error", error: { errorMessage: `Provider finish_reason: ${raw}`, rawStopReason: raw } }),
        ]),
      ).toEqual([
        { type: "text-delta", text: "half " },
        { type: "finish", finish: { kind: "max-tokens", rawReason: raw } },
      ]);
    }
  });

  it("error 救回：toolcall 内容同算（截断前已交付完整调用）", async () => {
    expect(
      await collect([
        assistantEvent({ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "t1", name: "add", arguments: { a: 1 } } }),
        assistantEvent({ type: "error", reason: "error", error: { errorMessage: "Provider finish_reason: max_tokens", rawStopReason: "max_tokens" } }),
      ]),
    ).toEqual([
      { type: "tool-call-delta", index: 0, callId: "t1", name: "add", argumentsDelta: '{"a":1}' },
      { type: "finish", finish: { kind: "max-tokens", rawReason: "max_tokens" } },
    ]);
  });

  it("error 救回内容前置：零内容（仅 thinking / 全空）不救回——model_context_window_exceeded 零内容落 context-overflow", async () => {
    expect(
      await collect([
        assistantEvent({ type: "thinking_delta", contentIndex: 0, delta: "思考不算内容" }),
        assistantEvent({
          type: "error",
          reason: "error",
          error: { errorMessage: "Provider finish_reason: model_context_window_exceeded", rawStopReason: "model_context_window_exceeded" },
        }),
      ]),
    ).toEqual([{ type: "thinking-delta", text: "思考不算内容" }, { type: "finish", finish: { kind: "error", message: "Provider finish_reason: model_context_window_exceeded", code: "context-overflow" } }]);
    expect(
      await collect([
        assistantEvent({ type: "error", reason: "error", error: { errorMessage: "Provider finish_reason: model_context_window_exceeded", rawStopReason: "model_context_window_exceeded" } }),
      ]),
    ).toEqual([{ type: "finish", finish: { kind: "error", message: "Provider finish_reason: model_context_window_exceeded", code: "context-overflow" } }]);
  });

  it("overflow 文本分类优先于状态码：400+文案 → context-overflow（非 http-400）；413 request_too_large → context-overflow", async () => {
    expect(
      await collect([assistantEvent({ type: "error", reason: "error", error: { errorMessage: "prompt is too long: 213462 tokens > 200000 maximum" } })], {
        failureInfo: () => ({ status: 400 }),
      }),
    ).toEqual([{ type: "finish", finish: { kind: "error", message: "prompt is too long: 213462 tokens > 200000 maximum", code: "context-overflow" } }]);
    expect(
      await collect([assistantEvent({ type: "error", reason: "error", error: { errorMessage: '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}' } })], {
        failureInfo: () => ({ status: 413 }),
      }),
    ).toEqual([
      { type: "finish", finish: { kind: "error", message: '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}', code: "context-overflow" } },
    ]);
  });

  it("限流保护：429/503 状态码在场时跳过 overflow 文本分类（『too many tokens』等限流文案不得换走 emergency 压缩）", async () => {
    // Bedrock ThrottlingException 经网关转发无前缀形态——曾误命中 /too many tokens/i
    expect(
      await collect([assistantEvent({ type: "error", reason: "error", error: { errorMessage: "Too many tokens, please wait before trying again." } })], {
        failureInfo: () => ({ status: 429 }),
      }),
    ).toEqual([{ type: "finish", finish: { kind: "error", message: "Too many tokens, please wait before trying again.", code: "http-429" } }]);
    expect(
      await collect([assistantEvent({ type: "error", reason: "error", error: { errorMessage: "prompt is too long" } })], {
        failureInfo: () => ({ status: 503 }),
      }),
    ).toEqual([{ type: "finish", finish: { kind: "error", message: "prompt is too long", code: "http-503" } }]);
  });

  it("overflow 负例：纯 413 无 overflow 文案保持 http-413；throttling 排除集不误判；其它既有分类不漂移", async () => {
    expect(
      await collect([assistantEvent({ type: "error", reason: "error", error: { errorMessage: "gateway rejected" } })], {
        failureInfo: () => ({ status: 413 }),
      }),
    ).toEqual([{ type: "finish", finish: { kind: "error", message: "gateway rejected", code: "http-413" } }]);
    expect(
      await collect([assistantEvent({ type: "error", reason: "error", error: { errorMessage: "Throttling error: Too many tokens, please wait before trying again." } })]),
    ).toEqual([{ type: "finish", finish: { kind: "error", message: "Throttling error: Too many tokens, please wait before trying again.", code: "network" } }]);
    expect(await collect([assistantEvent({ type: "error", reason: "error", error: { errorMessage: "fetch failed" } })])).toEqual([
      { type: "finish", finish: { kind: "error", message: "fetch failed", code: "network" } },
    ]);
  });
});

describe("classifyErrorText（词边界负例全表）", () => {
  it("正例：状态码/网络词族", () => {
    expect(classifyErrorText("HTTP 429 too many")).toBe("http-429");
    expect(classifyErrorText("503 Service")).toBe("http-503");
    expect(classifyErrorText("fetch failed")).toBe("network");
    expect(classifyErrorText("Request timed out")).toBe("network");
    expect(classifyErrorText("overloaded_error")).toBe("network");
  });

  it("负例：数值子串不误杀；鉴权/refusal 落无 code", () => {
    expect(classifyErrorText("used 14290 tokens")).toBe("network"); // 不是 429
    expect(classifyErrorText("econnrefused 127.0.0.1:14001")).toBe("network");
    expect(classifyErrorText("request id 15003 failed")).toBe("network");
    expect(classifyErrorText("invalid api key")).toBeUndefined();
    expect(classifyErrorText("401 Unauthorized")) .toBe("http-401");
    expect(classifyErrorText("content_filter blocked")).toBeUndefined();
    expect(classifyErrorText("stop reason refusal")).toBeUndefined();
  });
});
