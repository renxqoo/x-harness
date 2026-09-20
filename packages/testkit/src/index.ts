// 测试装置件（SDK-MIGRATION-F3）：脚本假 adapter + 文本剧本 + 假工具——
// 插件作者「写完即测」与 e2e journey 共用的最小装置。纯函数零副作用（无 IO/定时器）。

import type { LlmAdapter, LlmChunk, LlmRequest } from "@x-harness/llm";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolOutcome } from "@x-harness/tools";

/** 单条文本剧本（stop 收束） */
export function textScript(text: string, finish: "stop" | "max-tokens" = "stop"): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "finish", finish: { kind: finish } };
  })();
}

/** 脚本耗尽的回落形态：缺省 "(no script)" 文本；可参数化（journey 形态各异——F-10 处置） */
export type ExhaustedFallback = string | ((request: LlmRequest) => AsyncGenerator<LlmChunk>);

/** 脚本化假 adapter：每次调用弹一段剧本；calls 捕获请求 */
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

/** 假工具：空 schema + 计数可选（run 内自增即可） */
export function fakeTool(name: string, run: () => ToolOutcome | Promise<ToolOutcome>): ToolDefinition {
  return {
    name,
    description: `fake tool ${name}`,
    inputSchema: Type.Object({}),
    execute: async () => run(),
  };
}
