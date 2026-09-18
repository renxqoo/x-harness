import { describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Context, Disposer } from "@x-harness/core";
import { llmPlugin, llmRuntime, llmStream } from "../index.ts";
import type { LlmChunk, LlmRequest, LlmRuntime } from "../index.ts";

const request = (overrides: Partial<LlmRequest> = {}): LlmRequest => ({
  model: "m",
  tools: [],
  messages: [],
  signal: new AbortController().signal,
  ...overrides,
});

async function assemble(): Promise<{ ctx: Context; llm: LlmRuntime; unload: readonly Disposer[] }> {
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [llmPlugin]);
  return { ctx, llm: ctx.use(llmRuntime), unload };
}

async function collect(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const chunks: LlmChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("runtime（docs/LLM.md §1.2）", () => {
  it("token 词表与重名 throw/disposer", async () => {
    expect(llmRuntime).toMatchObject({ kind: "service", name: "llm-runtime" });
    expect(llmStream).toMatchObject({ kind: "waterfall", mode: "waterfall", name: "llm/stream" });
    const { llm } = await assemble();
    const off = llm.registerAdapter({ name: "a", stream: async function* () {} });
    expect(() => llm.registerAdapter({ name: "a", stream: async function* () {} })).toThrow("already registered");
    off();
    llm.registerAdapter({ name: "a", stream: async function* () {} });
  });

  it("provider 解析：命名命中 / 未注册 throw / 缺省唯一 / 缺省零个 throw", async () => {
    const { llm } = await assemble();
    await expect(collect(llm.stream(request()))).rejects.toThrow("no-adapter:none-registered");
    llm.registerAdapter({ name: "a", stream: async function* () { yield { type: "finish", finish: { kind: "stop" } }; } });
    await expect(collect(llm.stream(request({ provider: "x" })))).rejects.toThrow("no-adapter:x");
    expect((await collect(llm.stream(request()))).map((c) => c.type)).toEqual(["finish"]);
  });

  it("llm/stream waterfall：中间件可改写流（注入额外 chunk）", async () => {
    const { ctx, llm } = await assemble();
    llm.registerAdapter({ name: "a", stream: async function* () { yield { type: "text-delta", text: "hi" } as LlmChunk; } });
    const off = ctx.on(llmStream, async (req, next) => {
      const stream = await next(req);
      async function* wrapped(): AsyncGenerator<LlmChunk> {
        yield { type: "text-delta", text: "[" };
        for await (const chunk of stream) yield chunk;
        yield { type: "text-delta", text: "]" };
      }
      return wrapped();
    });
    expect((await collect(llm.stream(request()))).map((c) => (c as { text?: string }).text ?? "")).toEqual(["[", "hi", "]"]);
    off();
  });
});
