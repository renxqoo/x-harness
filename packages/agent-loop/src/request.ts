// 拨号折叠与请求头落账（docs/AGENT-LOOP-DRIVER.md §1.4）：options 显式值恒胜；否则末次 request/header
// 同名字段；中间件改写落 header 后成为后续折叠基底（有意粘性）。header 落 ToolRef 投影；diff 含 tools。

import type { Session, SessionEvent, ToolRef } from "@x-harness/session";
import type { ToolSchema } from "@x-harness/tools";
import type { Dial } from "./tokens.ts";

interface HeaderSnapshot {
  readonly model: string;
  readonly provider?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly tools: readonly ToolRef[];
}

function lastHeader(events: readonly SessionEvent[]): HeaderSnapshot | undefined {
  let snapshot: HeaderSnapshot | undefined;
  for (const event of events) {
    if (event.type !== "request/header") continue;
    snapshot = {
      model: event.data.model,
      ...(event.data.provider !== undefined ? { provider: event.data.provider } : {}),
      ...(event.data.temperature !== undefined ? { temperature: event.data.temperature } : {}),
      ...(event.data.maxTokens !== undefined ? { maxTokens: event.data.maxTokens } : {}),
      tools: event.data.tools,
    };
  }
  return snapshot;
}

/** 逐字段折叠：options 显式值恒胜，否则末次 header 同名字段 */
export function foldDial(
  options: { provider?: string; model?: string; temperature?: number; maxTokens?: number },
  events: readonly SessionEvent[],
): Dial | { readonly missing: true } {
  const header = lastHeader(events);
  const model = options.model ?? header?.model;
  if (model === undefined || model === "") return { missing: true };
  const provider = options.provider ?? header?.provider;
  const temperature = options.temperature ?? header?.temperature;
  const maxTokens = options.maxTokens ?? header?.maxTokens;
  return {
    model,
    ...(provider !== undefined ? { provider } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

export function toToolRefs(schemas: readonly ToolSchema[]): ToolRef[] {
  return schemas.map((tool) =>
    tool.description === undefined ? { name: tool.name } : { name: tool.name, description: tool.description },
  );
}

/** header 是否需要落账：与末次快照规范化比较（含 tools） */
export function headerChanged(dial: Dial, tools: readonly ToolRef[], events: readonly SessionEvent[]): boolean {
  const header = lastHeader(events);
  if (header === undefined) return true;
  return (
    header.model !== dial.model ||
    header.provider !== dial.provider ||
    header.temperature !== dial.temperature ||
    header.maxTokens !== dial.maxTokens ||
    JSON.stringify(header.tools) !== JSON.stringify(tools)
  );
}

export function lastRequestContext(events: readonly SessionEvent[]): { readonly provider: string; readonly model: string } | undefined {
  let context: { provider: string; model: string } | undefined;
  for (const event of events) {
    if (event.type === "request/context") context = { provider: event.data.provider, model: event.data.model };
  }
  return context;
}

export type { Session };
