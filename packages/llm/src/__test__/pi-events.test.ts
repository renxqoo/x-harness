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
  options?: { signal?: AbortSignal; failureInfo?: () => { status?: number; retryAfterMs?: number } },
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
  })) {
    out.push(chunk);
  }
  return out;
}

async function collectRacy(
  script: (emit: (event: AssistantMessageEvent) => void, yieldToConsumer: () => Promise<void>) => Promise<void>,
): Promise<LlmChunk[]> {
  const queue: AssistantMessageEvent[] = [];
  let parkedResolve: (() => void) | undefined;
  let scriptDone = false;
  const emit = (event: AssistantMessageEvent): void => {
    queue.push(event);
    if (parkedResolve !== undefined) {
      const wake = parkedResolve;
      parkedResolve = undefined;
      wake();
    }
  };
  const yieldToConsumer = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });
    await new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });
  };
  const iterable = {
    [Symbol.asyncIterator]: (): AsyncIterator<AssistantMessageEvent> => ({
      next: async (): Promise<IteratorResult<AssistantMessageEvent>> =>
        new Promise((resolve) => {
          const tick = (): void => {
            if (queue.length > 0) resolve({ done: false, value: queue.shift() as AssistantMessageEvent });
            else if (scriptDone) resolve({ done: true, value: undefined });
            else parkedResolve = tick;
          };
          tick();
        }),
    }),
  };
  const collected: LlmChunk[] = [];
  const consumer = (async () => {
    for await (const chunk of piChunks(iterable, { signal: idleSignal(), failureInfo: noFailure })) collected.push(chunk);
  })();
  await script(emit, yieldToConsumer);
  scriptDone = true;
  parkedResolve?.();
  await consumer;
  return collected;
}

describe("piChunks 事件矩阵（docs/LLM-PI.md 契约 2）", () => {
  it("start 事件不读 partial（首字重复症状「四四门全绿」，真实竞态时序复现）：pi 的 partial 是共享可变引用，消费者挂起等网络时单 burst 内到达 content_block_start+首条 delta——消费者醒来读 start 帧时 block.text 已含首字，start 帧补发初值必把已发 delta 重发一遍", async () => {
    const output = { content: [{ type: "text", text: "" }] };
    const chunks = await collectRacy(async (emit, yieldToConsumer) => {
      await yieldToConsumer();
      emit(assistantEvent({ type: "text_start", contentIndex: 0, partial: output }));
      (output.content[0] as { text: string }).text = "四";
      emit(assistantEvent({ type: "text_delta", contentIndex: 0, delta: "四", partial: output }));
      await yieldToConsumer();
      (output.content[0] as { text: string }).text = "四门全绿。";
      emit(assistantEvent({ type: "text_delta", contentIndex: 0, delta: "门全绿。", partial: output }));
      emit(assistantEvent({ type: "text_end", contentIndex: 0, content: "四门全绿。", partial: output }));
      emit(doneEvent());
    });
    const textDeltas = chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => (chunk as { text: string }).text);
    expect(textDeltas.join("")).toBe("四门全绿。");
  });

  it("thinking 通道同款（真实竞态时序）：start 不读 partial，首帧零产出，尾段由 end 终态校正补齐", async () => {
    const output = { content: [{ type: "thinking", thinking: "" }] };
    const chunks = await collectRacy(async (emit, yieldToConsumer) => {
      await yieldToConsumer();
      emit(assistantEvent({ type: "thinking_start", contentIndex: 0, partial: output }));
      (output.content[0] as { thinking: string }).thinking = "思";
      emit(assistantEvent({ type: "thinking_delta", contentIndex: 0, delta: "思", partial: output }));
      await yieldToConsumer();
      (output.content[0] as { thinking: string }).thinking = "思考完毕";
      emit(assistantEvent({ type: "thinking_end", contentIndex: 0, content: "思考完毕", partial: output }));
      emit(doneEvent());
    });
    const thinkingDeltas = chunks.filter((chunk) => chunk.type === "thinking-delta").map((chunk) => (chunk as { text: string }).text);
    expect(thinkingDeltas.join("")).toBe("思考完毕");
  });

  it("症状回归「多轮工具调用的 reasoning 签名丢失」L1：thinking_end 从 partial 提取签名块（thinking-signature chunk）——openai 加密项与 anthropic 签名同通道", async () => {
    const output = { role: "assistant", content: [{ type: "thinking", thinking: "思考", thinkingSignature: "[{\"type\":\"reasoning.encrypted\",\"data\":\"rs_abc\"}]", redacted: false, index: 0 }], api: "openai-completions", provider: "gpt", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timestamp: 0 };
    const chunks = await collectRacy(async (emit) => {
      emit(assistantEvent({ type: "thinking_start", contentIndex: 0, partial: output }));
      emit(assistantEvent({ type: "thinking_delta", contentIndex: 0, delta: "思", partial: output }));
      emit(assistantEvent({ type: "thinking_end", contentIndex: 0, content: "思考", partial: output }));
      emit(doneEvent());
    });
    const sig = chunks.find((chunk) => chunk.type === "thinking-signature") as { type: "thinking-signature"; signature: string; redacted: boolean } | undefined;
    expect(sig).toBeDefined();
    expect(sig?.signature).toContain("rs_abc");
    expect(sig?.redacted).toBe(false);
  });

  it("L1 中断路径：无 thinking_end 的流不产签名 chunk（半截签名不上 wire——完整性门在源头）", async () => {
    const output = { role: "assistant", content: [{ type: "thinking", thinking: "半截", thinkingSignature: "partial-sig", index: 0 }], api: "openai-completions", provider: "gpt", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timestamp: 0 };
    const chunks = await collectRacy(async (emit) => {
      emit(assistantEvent({ type: "thinking_start", contentIndex: 0, partial: output }));
      emit(assistantEvent({ type: "thinking_delta", contentIndex: 0, delta: "半截", partial: output }));
      emit(assistantEvent({ type: "error", reason: "error", error: output as never }) as never);
    }).catch(() => [] as LlmChunk[]);
    expect(chunks.find((chunk) => chunk.type === "thinking-signature")).toBeUndefined();
  });

  it("终态校正：wire 尾段未被 delta 覆盖时补发（text_end/thinking_end）", async () => {
    const chunks = await collect([
      assistantEvent({ type: "text_start", contentIndex: 0, partial: { content: [] } }),
      assistantEvent({ type: "text_delta", contentIndex: 0, delta: "hel" }),
      assistantEvent({ type: "text_end", contentIndex: 0, content: "hello" }),
      doneEvent(),
    ]);
    expect(chunks).toEqual([
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo" },
      { type: "finish", finish: { kind: "stop" } },
    ]);
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
      assistantEvent({ type: "toolcall_start", contentIndex: 2, partial: { content: [] } }),
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
    const extra = await collect([
      assistantEvent({ type: "done", reason: "stop", message: { usage } }),
      assistantEvent({ type: "text_delta", contentIndex: 0, delta: "late" }),
    ]);
    expect(extra.filter((c) => c.type === "finish")).toHaveLength(1);
    expect(extra.at(-1)?.type).toBe("finish");
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
    expect(foldUsage({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 })).toEqual([{ type: "usage", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }]);
  });

  it("error：usage 先行（失败尝试计费）→ 状态码在场落 http-<status> + retryAfterMs 透传", async () => {
    const chunks = await collect([assistantEvent({ type: "error", reason: "error", error: { usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 }, errorMessage: "rate limited" } })], {
      failureInfo: () => ({ status: 429, retryAfterMs: 2500 }),
    });
    expect(chunks).toEqual([
      { type: "usage", usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 } },
      { type: "finish", finish: { kind: "error", message: "rate limited", code: "http-429", retryAfterMs: 2500 } },
    ]);
  });

  it("回归：refusal 真身文案（\"The model refused…\"）与 rawStopReason 均落显式 non-retryable（不可重试）", async () => {
    const byText = await collect([
      assistantEvent({ type: "error", reason: "error", error: { errorMessage: "The model refused to complete the request" } }),
    ]);
    expect(byText).toEqual([
      { type: "finish", finish: { kind: "error", message: "The model refused to complete the request", code: "non-retryable" } },
    ]);
    const byRaw = await collect([assistantEvent({ type: "error", reason: "error", error: { errorMessage: "anything", rawStopReason: "refusal" } })], {
      failureInfo: () => ({ status: 500 }),
    });
    expect(byRaw).toEqual([{ type: "finish", finish: { kind: "error", message: "anything", code: "non-retryable", rawReason: "refusal" } }]);
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
      { type: "finish", finish: { kind: "error", message: "request refusal", code: "non-retryable" } },
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
  it("回归（用户实报 MiMo 零输出截断）：done length + usage.output===0 → context-overflow（自愈可期），不落静默粘性收轮", async () => {
    expect(
      await collect([assistantEvent({ type: "done", reason: "length", message: { usage: { input: 141174, output: 0, cacheRead: 0, cacheWrite: 0 } } })]),
    ).toEqual([
      { type: "usage", usage: { input: 141174, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { type: "finish", finish: { kind: "error", message: "length stop with zero output (context window overflow)", code: "context-overflow" } },
    ]);
    expect(
      await collect([assistantEvent({ type: "done", reason: "length", message: { usage: { input: 10, output: 8192, cacheRead: 0, cacheWrite: 0 } } })]),
    ).toEqual([{ type: "usage", usage: { input: 10, output: 8192, cacheRead: 0, cacheWrite: 0 } }, { type: "finish", finish: { kind: "max-tokens" } }]);
    expect(await collect([assistantEvent({ type: "done", reason: "length", message: {} })])).toEqual([{ type: "finish", finish: { kind: "max-tokens" } }]);
  });

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

  it("overflow 分类无保护序：限流文案命中 overflow pattern 时 429/503 在场也照报 context-overflow（瞬态甄别归消费端 retryableCodes——出口层不代编排）", async () => {
    expect(
      await collect([assistantEvent({ type: "error", reason: "error", error: { errorMessage: "Too many tokens, please wait before trying again." } })], {
        failureInfo: () => ({ status: 429 }),
      }),
    ).toEqual([{ type: "finish", finish: { kind: "error", message: "Too many tokens, please wait before trying again.", code: "context-overflow" } }]);
    expect(
      await collect([assistantEvent({ type: "error", reason: "error", error: { errorMessage: "prompt is too long" } })], {
        failureInfo: () => ({ status: 503 }),
      }),
    ).toEqual([{ type: "finish", finish: { kind: "error", message: "prompt is too long", code: "context-overflow" } }]);
    expect(
      await collect([assistantEvent({ type: "error", reason: "error", error: { errorMessage: "rate limited" } })], {
        failureInfo: () => ({ status: 429 }),
      }),
    ).toEqual([{ type: "finish", finish: { kind: "error", message: "rate limited", code: "http-429" } }]);
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

  it("负例：数值子串不误杀；鉴权/refusal 落显式 non-retryable", () => {
    expect(classifyErrorText("used 14290 tokens")).toBe("network");
    expect(classifyErrorText("econnrefused 127.0.0.1:14001")).toBe("network");
    expect(classifyErrorText("request id 15003 failed")).toBe("network");
    expect(classifyErrorText("invalid api key")).toBe("non-retryable");
    expect(classifyErrorText("401 Unauthorized")) .toBe("http-401");
    expect(classifyErrorText("content_filter blocked")).toBe("non-retryable");
    expect(classifyErrorText("stop reason refusal")).toBe("non-retryable");
  });
});
