import type { Session, SessionEvent, ToolRef } from "@x-harness/session";
import type { ToolSchema } from "@x-harness/tools";
import type { Dial } from "./tokens.ts";

interface HeaderSnapshot {
  readonly model: string;
  readonly provider?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly thinking?: Dial["thinking"];
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
      ...(event.data.thinking !== undefined ? { thinking: event.data.thinking as Dial["thinking"] } : {}),
      tools: event.data.tools,
    };
  }
  return snapshot;
}

function pick<T>(fromOptions: T | undefined, fromHeader: T | undefined): T | undefined {
  return fromOptions ?? fromHeader;
}

export function foldDial(
  options: { provider?: string; model?: string; temperature?: number; maxTokens?: number; thinking?: Dial["thinking"] },
  events: readonly SessionEvent[],
): Dial | { readonly missing: true } {
  const header = lastHeader(events);
  const model = pick(options.model, header?.model);
  if (model === undefined || model === "") return { missing: true };
  const provider = pick(options.provider, header?.provider);
  const temperature = pick(options.temperature, header?.temperature);
  const maxTokens = pick(options.maxTokens, header?.maxTokens);
  const thinking = pick(options.thinking, header?.thinking);
  return {
    model,
    ...(provider !== undefined ? { provider } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
}

export function toToolRefs(schemas: readonly ToolSchema[]): ToolRef[] {
  return schemas.map((tool) =>
    tool.description === undefined ? { name: tool.name } : { name: tool.name, description: tool.description },
  );
}

export function headerChanged(dial: Dial, tools: readonly ToolRef[], events: readonly SessionEvent[]): boolean {
  const header = lastHeader(events);
  if (header === undefined) return true;
  return (
    header.model !== dial.model ||
    header.provider !== dial.provider ||
    header.temperature !== dial.temperature ||
    header.maxTokens !== dial.maxTokens ||
    header.thinking !== dial.thinking ||
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
