import type { Context, Disposer, Plugin } from "@x-harness/core";
import { createLlmRuntime } from "./runtime.ts";
import { llmRuntime, llmStream } from "./tokens.ts";

export const llmPlugin = {
  name: "llm",
  apply: (ctx: Context): Disposer => {
    const runtime = createLlmRuntime({
      dispatchStream: (request, final) => ctx.dispatch(llmStream, request, final),
    });
    return ctx.provide(llmRuntime, runtime);
  },
} satisfies Plugin;
