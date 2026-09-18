// LlmRuntime 装配：适配器注册/解析 + llm/stream waterfall 派发（docs/LLM.md §1.2）。

import type { LlmAdapter, LlmChunk, LlmRequest, LlmRuntime } from "./types.ts";

export interface RuntimeDeps {
  readonly dispatchStream: (
    request: LlmRequest,
    final: (request: LlmRequest) => Promise<AsyncIterable<LlmChunk>>,
  ) => Promise<AsyncIterable<LlmChunk>>;
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
      const iterable = deps.dispatchStream(request, async (req) => resolve(req.provider).stream(req));
      return {
        [Symbol.asyncIterator]: () => {
          const iterator = iterable.then((stream) => stream[Symbol.asyncIterator]());
          return {
            next: () => iterator.then((it) => it.next()),
            throw: (reason) => iterator.then((it) => (it.throw ? it.throw(reason) : Promise.reject(reason))),
            return: () => iterator.then((it) => (it.return ? it.return() : Promise.resolve({ value: undefined, done: true as const }))),
          };
        },
      };
    },
  };
}
