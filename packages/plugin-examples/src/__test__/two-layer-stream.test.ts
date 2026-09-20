// F0 关系验证：agent/llm-stream（agent 层包裹）与 llm/stream（root 层全局）两层串联——
// agent 层 final = llm.stream，其内再经全局面（文档声称，此处实测）。

import { describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { llmPlugin, llmRuntime, llmStream } from "@x-harness/llm";
import type { LlmChunk } from "@x-harness/llm";
import { agentLlmStream } from "@x-harness/agent-loop";
import { textScript } from "@x-harness/testkit";

async function* withPrefix(prefix: string, inner: AsyncIterable<LlmChunk>): AsyncGenerator<LlmChunk> {
  yield { type: "text-delta", text: prefix };
  for await (const chunk of inner) yield chunk;
}

describe("双层流拦截（F0 收口审查 3.1 的关系声称实测）", () => {
  it("agent 层在外、全局层在内、adapter 最内——两层串联都生效", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [llmPlugin]);
    const order: string[] = [];
    const offGlobal = ctx.on(llmStream, async (request, next) => {
      order.push("global-in");
      return withPrefix("[G]", await next(request));
    });
    ctx.use(llmRuntime).registerAdapter({ name: "fake", stream: () => textScript("core") });
    const offAgent = ctx.on(agentLlmStream, async (payload, next) => {
      order.push("agent-in");
      return withPrefix("[A]", await next(payload)); // final = llm.stream → 其内经全局面
    });
    const stream = await ctx.dispatch(agentLlmStream, { request: { model: "m", messages: [] } as never }, async () =>
      ctx.use(llmRuntime).stream({ model: "m", messages: [] } as never) as never);
    let out = "";
    for await (const chunk of stream) out += chunk.type === "text-delta" ? chunk.text : "";
    expect(out).toBe("[A][G]core"); // agent 层最外 → 全局 → adapter
    expect(order).toEqual(["agent-in", "global-in"]);
    offAgent();
    offGlobal();
    await ctx.dispose();
  });
});
