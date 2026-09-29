import type { Context, Disposer } from "@x-harness/core";
import { agentAssistantSettle, agentAssistantStream, agentLlmStream, agentPreStep, agentRequest, agentTurnStopping } from "@x-harness/agent-loop";
import type { AssistantSettlement, Dial } from "@x-harness/agent-loop";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionAuditEvent } from "@x-harness/session";
import type { ContentBlock, InboxEntry, SessionEvent, SessionId } from "@x-harness/session";
import { toolsExecute, toolsPreExecute } from "@x-harness/tools";
import type { ToolCallRequest, ToolOutcome } from "@x-harness/tools";


export function transformMessages(ctx: Context, fn: (claim: readonly InboxEntry[]) => readonly InboxEntry[] | Promise<readonly InboxEntry[]>): Disposer {
  return ctx.on(agentPreStep, async (payload, next) => {
    const decision = await next(payload);
    if ((decision as { kind?: string }).kind !== "enter") return decision;
    const current = (decision as { messages?: readonly InboxEntry[] }).messages ?? payload.claim;
    return { kind: "enter", messages: await fn(current) } as never;
  });
}

export function vetoStep(ctx: Context, fn: (claim: readonly InboxEntry[]) => string | undefined): Disposer {
  return ctx.on(agentPreStep, async (payload, next) => {
    const outcome = await next(payload);
    const reason = fn(payload.claim);
    return reason !== undefined ? ({ kind: "reject", reason } as never) : outcome;
  });
}

export function transformAssistant(ctx: Context, fn: (s: AssistantSettlement) => AssistantSettlement): Disposer {
  return ctx.on(agentAssistantSettle, async (payload, next) => {
    const out = await next(payload);
    const transformed = fn(out);
    return { content: transformed.content, stopReason: transformed.stopReason } as never;
  });
}


export function vetoTools(
  ctx: Context,
  fn: (call: { readonly callId: string; readonly name: string; readonly args: unknown; readonly session?: SessionId; readonly control?: true; readonly kind?: string; readonly readsSubtree?: true }) => { readonly kind: "deny"; readonly reason: string } | undefined,
): Disposer {
  return ctx.on(toolsPreExecute, async (payload, next) => {
    const inner = await next(payload);
    const deny = fn(payload as never);
    return (deny ?? inner) as never;
  });
}

export function transformToolResult(
  ctx: Context,
  fn: (outcome: ToolOutcome, request: ToolCallRequest) => ToolOutcome,
  opts?: { readonly prepend?: boolean },
): Disposer {
  return ctx.on(toolsExecute, async (request, next) => fn(await next(request), request) as never, opts);
}


export function transformDial(ctx: Context, fn: (dial: Dial) => Dial): Disposer {
  return ctx.on(agentRequest, async (payload, next) => fn(await next(payload)) as never);
}

export function wrapStream(ctx: Context, fn: (stream: AsyncIterable<LlmChunk>, request: LlmRequest) => AsyncIterable<LlmChunk>): Disposer {
  return ctx.on(agentLlmStream, async (payload, next) => fn(await next(payload), payload.request) as never);
}


export function tapAssistant(ctx: Context, fn: (s: AssistantSettlement) => void): Disposer {
  return ctx.on(agentAssistantSettle, async (payload, next) => {
    const out = await next(payload);
    fn(out);
    return out;
  });
}

export function tapToolCalls(ctx: Context, fn: (request: ToolCallRequest, outcome: ToolOutcome) => void): Disposer {
  return ctx.on(toolsExecute, async (request, next) => {
    const outcome = await next(request);
    fn(request, outcome);
    return outcome;
  });
}

export function tapStream(ctx: Context, fn: (frame: unknown) => void): Disposer {
  return ctx.on(agentAssistantStream, (payload) => {
    fn((payload as { frame?: unknown }).frame);
  });
}

export function tapTurnEnd(ctx: Context, fn: () => void): Disposer {
  return ctx.on(agentTurnStopping, () => fn());
}


export function textOf(content: readonly ContentBlock[]): string {
  return content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("");
}

export function textBlocksOf(content: readonly ContentBlock[]): readonly { type: "text"; text: string }[] {
  return content.filter((b): b is { type: "text"; text: string } => b.type === "text");
}

export function nonTextOf(content: readonly ContentBlock[]): readonly ContentBlock[] {
  return content.filter((b) => b.type !== "text");
}


export function tapSessionEvents(ctx: Context, fn: (event: SessionEvent, session: SessionId) => void): Disposer {
  return ctx.on(sessionAuditEvent, (payload) => fn(payload.event, payload.session));
}
