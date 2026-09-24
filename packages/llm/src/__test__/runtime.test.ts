// runtime 归一层与适配器解析（docs/LLM.md §1.3 / §3）：no-adapter 错误结算、同步/异步失败归一、
// abort 豁免、waterfall 改写、提前 break 清理委托、注册生命周期。

import { createContext, loadPlugins } from "@x-harness/core";
import { createAnthropicCompatLlm, createOpenaiCompatLlm, llmPlugin, llmRuntime, llmStream } from "../index.ts";
import type { LlmChunk, LlmRequest } from "../index.ts";
import { describe, expect, it } from "vitest";

function request(over: Partial<LlmRequest> = {}): LlmRequest {
  return { model: "m", tools: [], messages: [], signal: new AbortController().signal, ...over };
}

async function collect(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

function textAdapter(name: string, chunks: LlmChunk[] = [{ type: "text-delta", text: "hi" }]): { name: string; stream: (r: LlmRequest) => AsyncGenerator<LlmChunk> } {
  return {
    name,
    stream: async function* (): AsyncGenerator<LlmChunk> {
      yield* chunks;
    },
  };
}

async function makeRuntime() {
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [llmPlugin]);
  return { ctx, runtime: ctx.use(llmRuntime), cleanup: async () => { await ctx.dispose(); void unload; } };
}

describe("contextWindowOf 窗口查询（模型级 > 档案级 > 无名单适配器）", () => {
  it("点名 provider：模型级（contextWindowByModel）胜档案级；缺模型回退档案级", async () => {
    const { runtime, cleanup } = await makeRuntime();
    try {
      const off = runtime.registerAdapter({
        ...textAdapter("glm"),
        contextWindow: 1_000_000,
        contextWindowByModel: { "glm-air": 128_000 },
      } as never);
      expect(runtime.contextWindowOf("glm", "glm-air")).toBe(128_000);
      expect(runtime.contextWindowOf("glm", "glm-max")).toBe(1_000_000);
      expect(runtime.contextWindowOf("glm")).toBe(1_000_000);
      off();
    } finally {
      await cleanup();
    }
  });

  it("症状回归（多适配器无名查表不可答）：点名后可答；单适配器无名可答", async () => {
    const { runtime, cleanup } = await makeRuntime();
    try {
      const offA = runtime.registerAdapter({ ...textAdapter("a"), contextWindow: 111_111 } as never);
      expect(runtime.contextWindowOf()).toBe(111_111); // 单适配器无名可答
      const offB = runtime.registerAdapter({ ...textAdapter("b"), contextWindow: 222_222 } as never);
      expect(runtime.contextWindowOf()).toBeUndefined(); // 多适配器无名不可答（消费方须带会话拨号点名）
      expect(runtime.contextWindowOf("b")).toBe(222_222);
      offA();
      offB();
    } finally {
      await cleanup();
    }
  });
});

describe("LlmRuntime 注册生命周期（docs/LLM.md §3）", () => {
  it("重名 throw；名称/形状垃圾 throw；disposer 身份守卫注销后可重注册", async () => {
    const { runtime, cleanup } = await makeRuntime();
    try {
      const off = runtime.registerAdapter(textAdapter("a"));
      expect(() => runtime.registerAdapter(textAdapter("a"))).toThrow("already registered");
      expect(() => runtime.registerAdapter({ name: "", stream: textAdapter("x").stream })).toThrow();
      expect(() => runtime.registerAdapter({ name: "b", stream: "not-fn" as never })).toThrow();
      off();
      const reRegistered = runtime.registerAdapter(textAdapter("a")); // 注销后同名可重注册
      reRegistered();
    } finally {
      await cleanup();
    }
  });
});

describe("失败归一层（docs/LLM.md §1.2/§1.3——不向消费者裸 throw，abort 豁免）", () => {
  it("未注册 provider → no-adapter 错误流（保留区分信息），不 throw", async () => {
    const { runtime, cleanup } = await makeRuntime();
    try {
      const chunks = await collect(runtime.stream(request({ provider: "ghost" })));
      expect(chunks).toEqual([{ type: "finish", finish: { kind: "error", message: "no-adapter:ghost", code: "no-adapter" } }]);
    } finally {
      await cleanup();
    }
  });

  it("缺省零适配器 → none-registered；缺省多适配器 → ambiguous-N", async () => {
    const { runtime, cleanup } = await makeRuntime();
    try {
      expect(await collect(runtime.stream(request()))).toEqual([
        { type: "finish", finish: { kind: "error", message: "no-adapter:none-registered", code: "no-adapter" } },
      ]);
      runtime.registerAdapter(textAdapter("a"));
      runtime.registerAdapter(textAdapter("b"));
      expect(await collect(runtime.stream(request()))).toEqual([
        { type: "finish", finish: { kind: "error", message: "no-adapter:ambiguous-2", code: "no-adapter" } },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("适配器同步 throw（final 内）→ network 错误流", async () => {
    const { runtime, cleanup } = await makeRuntime();
    try {
      runtime.registerAdapter({
        name: "boom",
        stream: () => {
          throw new Error("sync blew");
        },
      });
      const chunks = await collect(runtime.stream(request({ provider: "boom" })));
      expect(chunks).toEqual([{ type: "finish", finish: { kind: "error", message: "sync blew", code: "network" } }]);
    } finally {
      await cleanup();
    }
  });

  it("流中异步 reject 任意值（非 Error）→ network 错误流", async () => {
    const { runtime, cleanup } = await makeRuntime();
    try {
      const partialThenThrow = async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "text-delta", text: "partial" };
        throw "raw string failure" as never;
      };
      runtime.registerAdapter({ name: "async-boom", stream: () => partialThenThrow() });
      const chunks = await collect(runtime.stream(request({ provider: "async-boom" })));
      expect(chunks.at(-1)).toEqual({ type: "finish", finish: { kind: "error", message: "raw string failure", code: "network" } });
    } finally {
      await cleanup();
    }
  });

  it("abort 豁免：流中 AbortError → throw 透传（不归一为 error finish）", async () => {
    const { runtime, cleanup } = await makeRuntime();
    try {
      const abortRightAway = async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "text-delta", text: "" }; // 不可达：先 throw——require-yield 达标用
        throw new DOMException("aborted", "AbortError");
      };
      runtime.registerAdapter({ name: "aborting", stream: () => abortRightAway() });
      await expect(collect(runtime.stream(request({ provider: "aborting" })))).rejects.toThrow("aborted");
    } finally {
      await cleanup();
    }
  });

  it("缺省唯一适配器解析成功并透传流", async () => {
    const { runtime, cleanup } = await makeRuntime();
    try {
      runtime.registerAdapter(textAdapter("only"));
      const chunks = await collect(runtime.stream(request()));
      expect(chunks).toEqual([{ type: "text-delta", text: "hi" }]);
    } finally {
      await cleanup();
    }
  });
});

describe("adapter-plugin（docs/LLM.md §1.4/§1.5 挂点）", () => {
  it("createOpenaiCompatLlm 注册 openai-compat 适配器到 runtime（可解析可流）", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [llmPlugin, createOpenaiCompatLlm({ baseUrl: "http://127.0.0.1:1", apiKey: "k" })]);
    const runtime = ctx.use(llmRuntime);
    const chunks = await collect(runtime.stream(request()));
    expect(chunks[0]).toMatchObject({ type: "finish", finish: { kind: "error", code: "network" } });
    await ctx.dispose();
    void unload;
  });

  it("createAnthropicCompatLlm 注册 anthropic-compat 适配器（provider 名一致可解析）", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [llmPlugin, createAnthropicCompatLlm({ baseUrl: "http://127.0.0.1:1", apiKey: "k" })]);
    const runtime = ctx.use(llmRuntime);
    const chunks = await collect(runtime.stream(request({ provider: "anthropic-compat", maxTokens: 32 })));
    expect(chunks[0]).toMatchObject({ type: "finish", finish: { kind: "error", code: "network" } });
    await ctx.dispose();
    void unload;
  });
});

describe("llm/stream waterfall 与迭代器委托（docs/LLM.md §3）", () => {
  it("中间件可改写流（包装 chunks）；中间件 throw 传播不吞", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [llmPlugin]);
    const runtime = ctx.use(llmRuntime);
    try {
      const prefixed = (inner: AsyncIterable<LlmChunk>): AsyncGenerator<LlmChunk> =>
        (async function* (): AsyncGenerator<LlmChunk> {
          yield { type: "text-delta", text: "prefix " };
          yield* inner;
        })();
      const off = ctx.on(llmStream, async (payload: LlmRequest, next: (input: LlmRequest) => Promise<AsyncIterable<LlmChunk>>) => prefixed(await next(payload)));
      runtime.registerAdapter(textAdapter("a", [{ type: "text-delta", text: "body" }]));
      expect(await collect(runtime.stream(request({ provider: "a" })))).toEqual([
        { type: "text-delta", text: "prefix " },
        { type: "text-delta", text: "body" },
      ]);
      off();
      const offThrow = ctx.on(llmStream, async (payload: LlmRequest, next: (input: LlmRequest) => Promise<AsyncIterable<LlmChunk>>) => {
        await next(payload);
        throw new Error("middleware blew");
      });
      await expect(collect(runtime.stream(request({ provider: "a" })))).rejects.toThrow("middleware blew");
      offThrow();
    } finally {
      await ctx.dispose();
      void unload;
    }
  });

  it("提前 break → 内层迭代器 return() 被调用（清理委托，恰一次）", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [llmPlugin]);
    const runtime = ctx.use(llmRuntime);
    try {
      let returns = 0;
      const twoChunks = async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "text-delta", text: "one" };
        yield { type: "text-delta", text: "two" };
      };
      const countingIterator = (): AsyncIterator<LlmChunk> => {
        const target = twoChunks()[Symbol.asyncIterator]();
        return {
          next: () => target.next(),
          return: () => {
            returns += 1;
            return target.return(undefined as never);
          },
        };
      };
      runtime.registerAdapter({ name: "cleanup", stream: () => ({ [Symbol.asyncIterator]: countingIterator }) });
      const stream = runtime.stream(request({ provider: "cleanup" }));
      const iterator = stream[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.return?.();
      expect(returns).toBe(1);
    } finally {
      await ctx.dispose();
      void unload;
    }
  });
});
