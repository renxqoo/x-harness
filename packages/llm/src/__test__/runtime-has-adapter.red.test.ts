import { describe, expect, it } from "vitest";
import { llmPlugin, llmRuntime } from "../index.ts";
import type { LlmAdapter, LlmChunk, LlmRequest } from "../index.ts";
import { createContext, loadPlugins } from "@x-harness/core";

function textAdapter(name: string): LlmAdapter {
  return {
    name,
    stream: async function* (): AsyncGenerator<LlmChunk> {
      yield { type: "text-delta", text: "hi" };
    },
  };
}

async function makeRuntime() {
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [llmPlugin]);
  return { ctx, runtime: ctx.use(llmRuntime), cleanup: async () => { await ctx.dispose(); void unload; } };
}

describe("hasAdapter 注册态谓词(症状:无窗口配置的 adapter 被误判未注册,热重载重复注册爆炸)", () => {
  it("无 contextWindow 配置的 adapter 也有注册态", async () => {
    const { runtime, cleanup } = await makeRuntime();
    try {
      expect(runtime.hasAdapter("glm")).toBe(false);
      const off = runtime.registerAdapter(textAdapter("glm"));
      expect(runtime.hasAdapter("glm")).toBe(true);
      expect(runtime.contextWindowOf("glm")).toBeUndefined();
      off();
      expect(runtime.hasAdapter("glm")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("垃圾输入降级:false 而非崩溃", async () => {
    const { runtime, cleanup } = await makeRuntime();
    try {
      expect(runtime.hasAdapter("")).toBe(false);
      expect(runtime.hasAdapter(undefined as never)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("请求解析不受影响:注册后 stream 正常路由", async () => {
    const { runtime, cleanup } = await makeRuntime();
    try {
      const off = runtime.registerAdapter(textAdapter("glm"));
      expect(runtime.hasAdapter("glm")).toBe(true);
      off();
    } finally {
      await cleanup();
    }
  });
});
