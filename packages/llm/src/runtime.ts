// LlmRuntime 装配（docs/LLM.md §1.3）：适配器注册/解析 + llm/stream waterfall 派发 + 失败归一层。
// 归一规则：适配器同步 throw（final 内）与流中异步异常都折为单条 error finish 流；
// abort 豁免（AbortError 或 signal 已断 → rethrow，驱动按 aborted 收尾不进 retry）。

import type { LlmAdapter, LlmChunk, LlmFinish, LlmRequest, LlmRuntime } from "./types.ts";

export interface RuntimeDeps {
  readonly dispatchStream: (
    request: LlmRequest,
    final: (request: LlmRequest) => Promise<AsyncIterable<LlmChunk>>,
  ) => Promise<AsyncIterable<LlmChunk>>;
}

function errorStream(finish: LlmFinish): AsyncIterable<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "finish", finish };
  })();
}

function isAbortLike(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

export function createLlmRuntime(deps: RuntimeDeps): LlmRuntime {
  const adapters = new Map<string, LlmAdapter>();

  const resolve = (provider: string | undefined): LlmAdapter => {
    if (provider !== undefined) {
      const adapter = adapters.get(provider);
      if (adapter === undefined) throw new Error(`no-adapter:${provider}`);
      return adapter;
    }
    if (adapters.size === 1) return [...adapters.values()][0] as LlmAdapter;
    const detail = adapters.size === 0 ? "none-registered" : `ambiguous-${String(adapters.size)}`;
    throw new Error(`no-adapter:${detail}`);
  };

  return {
    registerAdapter: (adapter: LlmAdapter) => {
      if (typeof adapter?.name !== "string" || adapter.name === "") throw new Error("adapter name must be a non-empty string");
      if (typeof adapter.stream !== "function") throw new Error(`adapter "${adapter.name}" must have a stream function`);
      if (adapters.has(adapter.name)) throw new Error(`adapter "${adapter.name}" already registered`);
      adapters.set(adapter.name, adapter);
      return () => {
        if (adapters.get(adapter.name) === adapter) adapters.delete(adapter.name);
      };
    },
    stream: (request: LlmRequest): AsyncIterable<LlmChunk> => {
      // 生成器体惰性：首次 next() 才派发（docs/LLM.md §1.3 语义变更落档）
      return (async function* (): AsyncGenerator<LlmChunk> {
        // dispatch 阶段异常（中间件违约）照常外抛——不吞不改写（S20 语义）；归一只在 final 与流消费阶段
        let finalSignal: AbortSignal = request.signal; // waterfall 最终收到的 signal（中间件可能换）——abort 豁免两段对称
        const inner = await deps.dispatchStream(request, async (req) => {
          finalSignal = req.signal;
          let adapter: LlmAdapter;
          try {
            adapter = resolve(req.provider);
          } catch (error) {
            // 解析失败 → 结构化 no-adapter 错误流（保留 provider/none-registered/ambiguous-N 区分）
            const message = error instanceof Error ? error.message : String(error);
            return errorStream({ kind: "error", message, code: "no-adapter" });
          }
          try {
            return adapter.stream(req);
          } catch (error) {
            if (req.signal.aborted || isAbortLike(error)) throw error;
            const message = error instanceof Error ? error.message : String(error);
            return errorStream({ kind: "error", message, code: "network" });
          }
        });
        try {
          yield* inner;
        } catch (error) {
          if (request.signal.aborted || finalSignal.aborted || isAbortLike(error)) throw error;
          const message = error instanceof Error ? error.message : String(error);
          yield { type: "finish", finish: { kind: "error", message, code: "network" } };
        }
      })();
    },
    contextWindowOf: (provider?: string, model?: string): number | undefined => {
      // 缺失 B 修复：按适配器查 contextWindow；唯一适配器缺省取之，多适配器须点名。
      // 窗口粒度：模型级（contextWindowByModel——目录 modelMeta 注入）> 档案级。
      let adapter;
      if (provider !== undefined) adapter = adapters.get(provider);
      else if (adapters.size === 1) adapter = [...adapters.values()][0];
      if (adapter === undefined) return undefined;
      if (model !== undefined) {
        const byModel = adapter.contextWindowByModel?.[model];
        if (byModel !== undefined) return byModel;
      }
      return adapter.contextWindow;
    },
  };
}
