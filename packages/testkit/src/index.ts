import type { LlmAdapter, LlmChunk, LlmRequest } from "@x-harness/llm";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolOutcome } from "@x-harness/tools";

export function textScript(text: string, finish: "stop" | "max-tokens" = "stop"): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "finish", finish: { kind: finish } };
  })();
}

export type ExhaustedFallback = string | ((request: LlmRequest) => AsyncGenerator<LlmChunk>);

export function scriptedAdapter(spec: {
  readonly name?: string;
  readonly calls?: LlmRequest[];
  readonly scripts: Array<AsyncGenerator<LlmChunk> | ((request: LlmRequest) => AsyncGenerator<LlmChunk>)>;
  readonly exhausted?: ExhaustedFallback;
}): LlmAdapter {
  const exhausted = spec.exhausted ?? "(no script)";
  return {
    name: spec.name ?? "fake",
    stream: (request) => {
      spec.calls?.push(request);
      const next = spec.scripts.shift();
      if (next === undefined) {
        return typeof exhausted === "string" ? textScript(exhausted) : exhausted(request);
      }
      return typeof next === "function" ? next(request) : next;
    },
  };
}

export function fakeTool(name: string, run: () => ToolOutcome | Promise<ToolOutcome>): ToolDefinition {
  return {
    name,
    description: `fake tool ${name}`,
    inputSchema: Type.Object({}),
    execute: async () => run(),
  };
}
