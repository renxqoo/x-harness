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
      return (async function* (): AsyncGenerator<LlmChunk> {
        let finalSignal: AbortSignal = request.signal;
        const inner = await deps.dispatchStream(request, async (req) => {
          finalSignal = req.signal;
          let adapter: LlmAdapter;
          try {
            adapter = resolve(req.provider);
          } catch (error) {
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
