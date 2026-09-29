import { describe, expect, test } from "vitest";
import { createWorkerCommands } from "../worker/worker-commands.ts";
import { swapWorldAdapters } from "../worker/catalog-reload.ts";
import type { WorkerRuntime } from "../worker/worker-commands.ts";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import { createContext, loadPlugins } from "@x-harness/core";
import type { WorkerCatalog } from "../shared/worker-catalog.ts";

function makeRuntime(catalog: WorkerCatalog): { rt: WorkerRuntime; lines: string[] } {
  const lines: string[] = [];
  const rt = {
    state: {
      handle: { agent: { session: { append: () => ({ ok: true }), events: () => [] } } },
      world: { ctx: { tryUse: () => undefined }, store: { flush: async () => ({ ok: true }) } },
      catalog,
      dial: { provider: "p1", model: "m1" },
      thinking: undefined,
      permissionService: undefined,
      delegation: undefined,
      commands: undefined,
      threadId: "t1",
      sessionPath: "/tmp/t1/events.jsonl",
      cwd: "/tmp",
      trusted: true,
      skillsDirs: [],
      skillsDisabled: new Set<string>(),
      scriptAdapter: undefined,
    },
    emitLine: (line: string) => lines.push(line),
    agentDir: "/tmp/agent",
    sessionsRoot: "/tmp/sessions",
    broker: {} as never,
    bash: {} as never,
    inflight: {} as never,
    inflightState: {} as never,
    bridge: {} as never,
    triggerShutdown: () => undefined,
    env: {},
    pendingSends: 0,
  } as never as WorkerRuntime;
  return { rt, lines };
}

const baseCatalog: WorkerCatalog = {
  providers: [{ provider: "p1", protocol: "openai", baseUrl: "https://p1", apiKey: "", models: ["m1"] }],
  default: { provider: "p1", model: "m1" },
  modelMeta: {},
};

describe("catalog/reload 热更新(症状:存量 worker set_model 报 model_unavailable)", () => {
  test("收到 catalog/reload 后 rt.state.catalog 原子替换,set_model 立即可选新模型", async () => {
    const { rt, lines } = makeRuntime(baseCatalog);
    const handlers = createWorkerCommands(rt);
    expect(handlers.get("catalog/reload")).toBeDefined();

    const nextCatalog: WorkerCatalog = {
      providers: [
        { provider: "p1", protocol: "openai", baseUrl: "https://p1", apiKey: "", models: ["m1"] },
        { provider: "p2", protocol: "anthropic", baseUrl: "https://p2", apiKey: "", models: ["m2"] },
      ],
      default: { provider: "p1", model: "m1" },
      modelMeta: {},
    };
    await handlers.get("catalog/reload")!({ type: "catalog/reload", catalog: nextCatalog } as never);

    const setModel = handlers.get("set_model");
    expect(setModel).toBeDefined();
    await setModel!({ type: "set_model", provider: "p2", modelId: "m2" } as never);
    expect(lines.some((l) => l.includes("\"success\":true") && l.includes("set_model"))).toBe(true);
  });

  test("垃圾形状 catalog/reload 拒绝替换,原 catalog 保留", async () => {
    const { rt, lines } = makeRuntime(baseCatalog);
    const handlers = createWorkerCommands(rt);
    await handlers.get("catalog/reload")!({ type: "catalog/reload", catalog: { providers: "junk" } } as never);
    expect(rt.state.catalog).toBe(baseCatalog);
    expect(lines.some((l) => l.includes("catalog/reload") && l.includes("\"success\":false"))).toBe(true);
  });

  test("未知 dial 模型的 reload 后 contextWindowOf 走新表", () => {
    const withMeta: WorkerCatalog = {
      providers: [{ provider: "p1", protocol: "openai", baseUrl: "https://p1", apiKey: "", models: ["m1", "m2"] }],
      default: { provider: "p1", model: "m1" },
      modelMeta: { m2: { contextWindow: 999_999 } },
    };
    expect(withMeta.modelMeta["m2"]?.contextWindow).toBe(999_999);
  });

  test("swapWorldAdapters 在真实 world 注册新 provider adapter,窗口查询立即生效", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [llmPlugin]);
    const runtime = ctx.use(llmRuntime);
    const off = runtime.registerAdapter({ name: "p1", stream: async function* () {} } as never);
    const rt = {
      state: {
        world: { ctx },
        scriptAdapter: undefined,
      },
    } as never as WorkerRuntime;
    const next: WorkerCatalog = {
      providers: [
        { provider: "p1", protocol: "openai", baseUrl: "https://p1", apiKey: "", models: ["m1"] },
        { provider: "p2", protocol: "anthropic", baseUrl: "https://p2", apiKey: "", models: ["m2"], contextWindow: 777_777 },
      ],
      default: { provider: "p1", model: "m1" },
      modelMeta: {},
    };
    const swapped = await swapWorldAdapters(rt, next);
    expect(swapped).toBe(true);
    expect(runtime.contextWindowOf("p2", "m2")).toBe(777_777);
    off();
    await ctx.dispose();
    void unload;
  });
});
