// pi-adapter 注入层（docs/LLM-PI.md 测试口径）：streamFn 收到的 model/context/options 断言、
// 同步抛折算、请求前 abort、parseRetryAfterMs 全态。

import { describe, expect, it } from "vitest";
import type { AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { createAnthropicCompatAdapter, createOpenaiCompatAdapter, parseRetryAfterMs } from "../pi-adapter.ts";
import type { PiStreamFn } from "../pi-adapter.ts";
import type { LlmChunk, LlmRequest } from "../types.ts";

function request(over: Partial<LlmRequest> = {}): LlmRequest {
  return { model: "m", tools: [], messages: [], signal: new AbortController().signal, ...over };
}

function collect(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  return (async () => {
    const out: LlmChunk[] = [];
    for await (const chunk of stream) out.push(chunk);
    return out;
  })();
}

type DoneEvent = Extract<AssistantMessageEvent, { type: "done" }>;

function doneEvent(): DoneEvent {
  return {
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 0,
    },
  };
}

describe("pi-adapter 注入层", () => {
  it("anthropic 工厂：identity 头/单 attempt/cacheRetention none/maxTokens 全缺席不注入（wire 省略——服务端默认，本地硬编码兜底已废除）/apiKey/signal 透传", async () => {
    const seen: Array<{ model: { api: string; id: string; baseUrl: string; provider: string; maxTokens: number }; context: Context; options: Record<string, unknown> }> = [];
    const streamFn: PiStreamFn = async function* (model, context, options) {
      seen.push({ model: model as never, context, options: options as Record<string, unknown> });
      yield doneEvent();
    };
    const controller = new AbortController();
    const adapter = createAnthropicCompatAdapter({ baseUrl: "http://x", apiKey: "k1", streamFn });
    const chunks = await collect(adapter.stream(request({ signal: controller.signal })));
    expect(chunks).toEqual([
      { type: "usage", usage: { input: 1, output: 2, totalTokens: 3 } },
      { type: "finish", finish: { kind: "stop" } },
    ]);
    const first = seen[0];
    if (first === undefined) throw new Error("streamFn 未被调用");
    expect(first.model.api).toBe("anthropic-messages");
    expect(first.model.id).toBe("m"); // id = request.model（请求体 model 来源——回归：适配器名曾误入请求体）
    expect(first.model.baseUrl).toBe("http://x");
    expect(first.model.provider).toBe("anthropic");
    expect(first.options["apiKey"]).toBe("k1");
    expect((first.options["headers"] as Record<string, string>)["accept-encoding"]).toBe("identity");
    expect(first.options["maxRetries"]).toBe(0);
    expect(first.options["cacheRetention"]).toBe("none");
    expect(Object.hasOwn(first.options, "maxTokens")).toBe(false); // 全缺席不注入——本地兜底废除（曾以 8192 顶掉目录真实配置）
    expect(first.model.maxTokens).toBeUndefined(); // model 条目同源缺席
    expect(first.options["signal"]).toBe(controller.signal);
    expect((first.model as Record<string, unknown>)["compat"]).toBeUndefined(); // anthropic 协议不挂 compat（无 developer/system 之分）
  });

  it("openai 工厂：系统提示词角色钉死 system——model.compat.supportsDeveloperRole=false（名单外中转 developer 角色 422 回归锚）", async () => {
    const seen: Array<{ model: Record<string, unknown> }> = [];
    const streamFn: PiStreamFn = async function* (model) {
      seen.push({ model: model as never });
      yield doneEvent();
    };
    const adapter = createOpenaiCompatAdapter({ baseUrl: "http://relay.example/v1", apiKey: "k", streamFn });
    await collect(adapter.stream(request({})));
    const compat = seen[0]?.model["compat"] as Record<string, unknown> | undefined;
    expect(compat).toBeDefined();
    expect(compat?.["supportsDeveloperRole"]).toBe(false); // 未知 baseUrl 探测恒 true → 此处必须覆写
  });

  it("anthropic 工厂：请求显式 maxTokens 恒胜档案 maxOutputTokens；配置在场填 options 与 model 条目；temperature 透传", async () => {
    const seen: Array<{ model: Record<string, unknown>; options: Record<string, unknown> }> = [];
    const streamFn: PiStreamFn = async function* (model, _context, options) {
      seen.push({ model: model as unknown as Record<string, unknown>, options: options as Record<string, unknown> });
      yield doneEvent();
    };
    const adapter = createAnthropicCompatAdapter({ baseUrl: "http://x", apiKey: "k", maxOutputTokens: 4096, streamFn });
    await collect(adapter.stream(request({ maxTokens: 64, temperature: 0.3 })));
    expect(seen[0]?.options["maxTokens"]).toBe(64);
    expect(seen[0]?.model["maxTokens"]).toBe(64);
    expect(seen[0]?.options["temperature"]).toBe(0.3);
    await collect(adapter.stream(request({})));
    expect(seen[1]?.options["maxTokens"]).toBe(4096);
    expect(seen[1]?.model["maxTokens"]).toBe(4096);
  });

  it("openai 工厂：双缺席不发（model 条目仍 8192 元数据）；仅请求显式或档案 maxOutputTokens 在场才发", async () => {
    const seen: Array<{ model: Record<string, unknown>; options: Record<string, unknown> }> = [];
    const streamFn: PiStreamFn = async function* (model, _context, options) {
      seen.push({ model: model as unknown as Record<string, unknown>, options: options as Record<string, unknown> });
      yield { ...doneEvent(), message: { ...doneEvent().message, api: "openai-completions" } } as never;
    };
    const adapter = createOpenaiCompatAdapter({ baseUrl: "http://x", apiKey: "k", streamFn });
    await collect(adapter.stream(request({})));
    expect(Object.hasOwn(seen[0]!.options, "maxTokens")).toBe(false); // 双缺席：wire 不带
    expect(seen[0]?.model["maxTokens"]).toBeUndefined(); // 同源缺席（兜底废除——两协议对称）
    await collect(adapter.stream(request({ maxTokens: 128 })));
    expect(seen[1]?.options["maxTokens"]).toBe(128);
    expect(seen[1]?.model["maxTokens"]).toBe(128);

    const configured = createOpenaiCompatAdapter({ baseUrl: "http://x", apiKey: "k", maxOutputTokens: 2048, streamFn });
    await collect(configured.stream(request({})));
    expect(seen[2]?.options["maxTokens"]).toBe(2048); // 档案配置在场 = 显式注入
    expect(seen[2]?.model["maxTokens"]).toBe(2048);
    await collect(configured.stream(request({ maxTokens: 128 })));
    expect(seen[3]?.options["maxTokens"]).toBe(128); // 请求显式恒胜档案配置
    expect(seen[3]?.model["maxTokens"]).toBe(128);
  });

  it("思考等级注入（anthropic）：low/medium/high → thinkingEnabled+effort+预算；off/缺省不发；openai 走 reasoning（streamSimple）", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const anthropicStream: PiStreamFn = async function* (_model, _context, options) {
      seen.push(options as Record<string, unknown>);
      yield doneEvent();
    };
    const adapter = createAnthropicCompatAdapter({ baseUrl: "http://x", apiKey: "k", streamFn: anthropicStream });
    await collect(adapter.stream(request({ thinking: "low" })));
    await collect(adapter.stream(request({ thinking: "high" })));
    await collect(adapter.stream(request({ thinking: "off" })));
    await collect(adapter.stream(request({})));
    expect(seen[0]?.["thinkingEnabled"]).toBe(true);
    expect(seen[0]?.["effort"]).toBe("low");
    expect(seen[0]?.["thinkingBudgetTokens"]).toBe(2048);
    expect(seen[1]?.["effort"]).toBe("high");
    expect(seen[1]?.["thinkingBudgetTokens"]).toBe(16384);
    expect(Object.hasOwn(seen[2] as object, "thinkingEnabled")).toBe(false); // off 不发
    expect(Object.hasOwn(seen[3] as object, "thinkingEnabled")).toBe(false); // 缺省不发

    const openaiSeen: Array<Record<string, unknown>> = [];
    const openaiStream: PiStreamFn = async function* (_model, _context, options) {
      openaiSeen.push(options as Record<string, unknown>);
      yield { ...doneEvent(), message: { ...doneEvent().message, api: "openai-completions" } } as never;
    };
    const openaiAdapter = createOpenaiCompatAdapter({ baseUrl: "http://x", apiKey: "k", streamFn: openaiStream });
    await collect(openaiAdapter.stream(request({ thinking: "high" })));
    expect(openaiSeen[0]?.["reasoning"]).toBe("high"); // openai：reasoning 透传（streamSimple 面钳制后映射 reasoningEffort）
    expect(Object.hasOwn(openaiSeen[0] as object, "thinkingEnabled")).toBe(false); // anthropic 专属形状不串协议
    await collect(openaiAdapter.stream(request({ thinking: "off" })));
    expect(Object.hasOwn(openaiSeen[1] as object, "reasoning")).toBe(false); // off 不发
  });

  it("同步抛折算：错误文案分类（api key → 无 code；连接类 → network）；abort 同步抛透传", async () => {
    const throwing: PiStreamFn = (): AsyncIterable<AssistantMessageEvent> => {
      throw new Error("Invalid API key provided");
    };
    const adapter = createAnthropicCompatAdapter({ baseUrl: "http://x", apiKey: "", streamFn: throwing });
    expect(await collect(adapter.stream(request({})))).toEqual([
      { type: "finish", finish: { kind: "error", message: "Invalid API key provided" } },
    ]);
    const netThrow: PiStreamFn = (): AsyncIterable<AssistantMessageEvent> => {
      throw new Error("fetch failed");
    };
    const netAdapter = createAnthropicCompatAdapter({ baseUrl: "http://x", apiKey: "k", streamFn: netThrow });
    expect(await collect(netAdapter.stream(request({})))).toEqual([
      { type: "finish", finish: { kind: "error", message: "fetch failed", code: "network" } },
    ]);
    const controller = new AbortController();
    controller.abort();
    await expect(collect(adapter.stream(request({ signal: controller.signal })))).rejects.toThrow();
  });

  it("fetch 注入经包装透传（非 2xx 捕获层包裹用户 fetch）", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fake = (async (_url: unknown, init?: unknown) => {
      seen.push((init as Record<string, unknown>) ?? {});
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const streamFn: PiStreamFn = async function* (_model, _context, options) {
      seen.push(options as Record<string, unknown>);
      yield doneEvent();
    };
    const adapter = createAnthropicCompatAdapter({ baseUrl: "http://x", apiKey: "k", fetch: fake, streamFn });
    await collect(adapter.stream(request({})));
    expect(typeof seen[0]?.["fetch"]).toBe("function"); // 包装层（捕获非 2xx 状态与 retry-after）
  });
});

describe("parseRetryAfterMs", () => {
  const now = (): Date => new Date("2026-01-01T00:00:00Z");

  it("秒（含小数/零）→ 毫秒；HTTP-date → 相对（过去=0）；不可解析 → undefined；空 → undefined", () => {
    expect(parseRetryAfterMs("2.5", now)).toBe(2500);
    expect(parseRetryAfterMs("3", now)).toBe(3000);
    expect(parseRetryAfterMs("0", now)).toBe(0);
    expect(parseRetryAfterMs("Wed, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfterMs("Wed, 01 Jan 2025 00:00:00 GMT", now)).toBe(0); // 过去=0 立即
    expect(parseRetryAfterMs("garbage", now)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
    expect(parseRetryAfterMs("", now)).toBeUndefined();
  });
});

describe("maxOutputTokensByModel 逐模型输出上限折叠（请求显式 > 逐模型 > 档案级）", () => {
  it("byModel 命中：该模型请求带 byModel 值（档案级与缺席模型回落各自成立）；model 条目与注入同源", async () => {
    const seen: Array<{ id: string; options: Record<string, unknown>; model: Record<string, unknown> }> = [];
    const streamFn: PiStreamFn = async function* (model, _context, options) {
      seen.push({ id: (model as { id: string }).id, options: options as Record<string, unknown>, model: model as unknown as Record<string, unknown> });
      yield doneEvent();
    };
    const adapter = createAnthropicCompatAdapter({
      baseUrl: "http://x",
      apiKey: "k",
      maxOutputTokens: 4096, // 档案级在场：byModel 命中模型不走此值
      maxOutputTokensByModel: { "big-x": 32_768 },
      streamFn,
    });
    await collect(adapter.stream(request({ model: "big-x" })));
    await collect(adapter.stream(request({ model: "plain-y" })));
    // big-x：逐模型值生效；plain-y：不在 byModel → 回落档案级
    expect(seen[0]?.id).toBe("big-x");
    expect(seen[0]?.options["maxTokens"]).toBe(32_768);
    expect(seen[0]?.model["maxTokens"]).toBe(32_768); // Model 条目与请求注入同源
    expect(seen[1]?.id).toBe("plain-y");
    expect(seen[1]?.options["maxTokens"]).toBe(4096);
    expect(seen[1]?.model["maxTokens"]).toBe(4096);
  });

  it("byModel 缺席模型回落档案级；档案级也无 → 不注入（wire 省略——服务端默认，无本地兜底）", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const streamFn: PiStreamFn = async function* (_model, _context, options) {
      seen.push(options as Record<string, unknown>);
      yield doneEvent();
    };
    const fallback = createAnthropicCompatAdapter({ baseUrl: "http://x", apiKey: "k", maxOutputTokensByModel: { "big-x": 32_768 }, streamFn });
    await collect(fallback.stream(request({ model: "plain-y" })));
    expect(Object.hasOwn(seen[0] ?? {}, "maxTokens")).toBe(false); // 档案级缺席 → 不注入（服务端默认接管）
    const none = createAnthropicCompatAdapter({ baseUrl: "http://x", apiKey: "k", streamFn });
    await collect(none.stream(request({ model: "plain-y" })));
    expect(Object.hasOwn(seen[1] ?? {}, "maxTokens")).toBe(false);
  });

  it("请求显式 maxTokens 恒胜 byModel（逐模型配置不压过请求显式值）", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const streamFn: PiStreamFn = async function* (_model, _context, options) {
      seen.push(options as Record<string, unknown>);
      yield doneEvent();
    };
    const adapter = createAnthropicCompatAdapter({ baseUrl: "http://x", apiKey: "k", maxOutputTokensByModel: { "big-x": 32_768 }, streamFn });
    await collect(adapter.stream(request({ model: "big-x", maxTokens: 512 })));
    expect(seen[0]?.["maxTokens"]).toBe(512);
  });

  it("openai 工厂：byModel 命中才发；byModel 与档案级双缺席不发（协议语义不变）", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const streamFn: PiStreamFn = async function* (_model, _context, options) {
      seen.push(options as Record<string, unknown>);
      yield { ...doneEvent(), message: { ...doneEvent().message, api: "openai-completions" } } as never;
    };
    const adapter = createOpenaiCompatAdapter({ baseUrl: "http://x", apiKey: "k", maxOutputTokensByModel: { "big-x": 32_768 }, streamFn });
    await collect(adapter.stream(request({ model: "big-x" })));
    expect(seen[0]?.["maxTokens"]).toBe(32_768); // byModel 命中 = 显式注入
    await collect(adapter.stream(request({ model: "plain-y" })));
    expect(Object.hasOwn(seen[1] as object, "maxTokens")).toBe(false); // 双缺席：wire 不带
  });
});

describe("Model.input 按请求查表（BATCH2-DESIGN §1.1——openai 协议缺 image 声明会把图降级为占位文本）", () => {
  it("inputByModel 命中 → 逐模型模态；缺席模型 → 缺省 [text]", async () => {
    const seen: Array<{ id: string; input: string[] }> = [];
    const streamFn: PiStreamFn = async function* (model) {
      seen.push({ id: (model as { id: string }).id, input: [...(model as { input: string[] }).input] });
      yield doneEvent();
    };
    const adapter = createOpenaiCompatAdapter({
      baseUrl: "http://x",
      apiKey: "k",
      streamFn,
      inputByModel: { "vision-x": ["text", "image"] },
    });
    await collect(adapter.stream(request({ model: "vision-x" })));
    await collect(adapter.stream(request({ model: "plain-y" })));
    expect(seen).toEqual([
      { id: "vision-x", input: ["text", "image"] },
      { id: "plain-y", input: ["text"] },
    ]);
  });
});
