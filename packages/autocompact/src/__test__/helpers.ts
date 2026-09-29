import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest, LlmRuntime } from "@x-harness/llm";
import { createCompactionPlugin } from "@x-harness/compaction";
import type { SummarizerFace } from "@x-harness/compaction";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { ContentBlock, Session, SessionEvent, SessionId, SessionStore, SurfaceNode, SurfaceOp } from "@x-harness/session";
import { createAutoCompactPlugin } from "../plugin.ts";

export function textScript(text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

export function emptyScript(): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

export function hangScript(): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text: "x" };
    await new Promise<void>(() => {});
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

export type ScriptEntry = AsyncGenerator<LlmChunk> | ((request: LlmRequest) => AsyncGenerator<LlmChunk>);

export interface FakeLlm {
  readonly runtime: LlmRuntime;
  readonly calls: LlmRequest[];
  readonly scripts: ScriptEntry[];
}

export function fakeLlm(): FakeLlm {
  const calls: LlmRequest[] = [];
  const scripts: ScriptEntry[] = [];
  const runtime: LlmRuntime = {
    registerAdapter: () => () => {},
    contextWindowOf: () => undefined,
    hasAdapter: () => false,
    stream: (request) => {
      calls.push(request);
      const entry = scripts.shift();
      if (entry === undefined) return emptyScript();
      return typeof entry === "function" ? entry(request) : entry;
    },
  };
  return { runtime, calls, scripts };
}

export function abortableScript(text: string): (request: LlmRequest) => AsyncGenerator<LlmChunk> {
  return (request) =>
    (async function* (): AsyncGenerator<LlmChunk> {
      yield { type: "text-delta", text };
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) {
          resolve();
          return;
        }
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "finish", finish: { kind: "stop" } };
    })();
}

export const FACE: SummarizerFace = { model: "sum", contextWindow: 100_000, maxOutputTokens: 100 };

export const COMPACTION_BASE = {
  contextWindow: 1_000,
  reserveTokens: 50,
  keepRecentTokens: 1,
  keepMinTurns: 5,
  triggerPct: 92,
  summarizer: { model: "sum", contextWindow: 100_000, maxOutputTokens: 100 },
} as const;

export const AUTOCOMPACT_BASE = {
  contextWindow: 1_000,
  checkpointPct: 60,
  l1Pct: 89,
  l2Pct: 89,
  warnBufferTokens: 100,
  checkpointMinSegmentTokens: 1,
  ledgerBudgetTokens: 200,
} as const;

export interface World {
  readonly ctx: Context;
  readonly store: SessionStore;
  readonly llm: FakeLlm;
}

export async function makeWorld(autoOptions?: Record<string, unknown>, compactionOptions?: Record<string, unknown>): Promise<World> {
  const ctx = createContext();
  const fake = fakeLlm();
  await loadPlugins(ctx, [
    sessionPlugin,
    createCompactionPlugin({ ...COMPACTION_BASE, ...compactionOptions } as never),
    createAutoCompactPlugin({ ...AUTOCOMPACT_BASE, ...autoOptions } as never),
  ]);
  ctx.provide(llmRuntime, fake.runtime);
  return { ctx, store: ctx.use(sessionStore), llm: fake };
}

function must(result: { ok: boolean; reason?: string }): void {
  if (!result.ok) throw new Error(`append failed: ${String(result.reason)}`);
}

export function seedTurn(
  session: Session,
  fields: { readonly turn: number; readonly user: string; readonly assistant: { readonly text: string; readonly thinking?: string; readonly usage?: { readonly input: number; readonly output: number } } },
): void {
  const { turn } = fields;
  must(session.append("turn/start", { turn }));
  must(session.append("step/start", { turn, step: 0 }));
  must(session.append("user/message", { turn, step: 0, content: [{ type: "text", text: fields.user }] }, { surfaceOp: "append" }));
  must(
    session.append(
      "assistant/message",
      {
        turn,
        step: 0,
        content: [{ type: "text", text: fields.assistant.text }],
        ...(fields.assistant.thinking !== undefined && fields.assistant.thinking !== "" ? { thinking: fields.assistant.thinking } : {}),
        ...(fields.assistant.usage !== undefined ? { usage: fields.assistant.usage } : {}),
        stopReason: "stop",
      },
      { surfaceOp: "append" },
    ),
  );
  must(session.append("step/end", { turn, step: 0 }));
  must(session.append("turn/end", { turn, reason: { kind: "completed" } }));
}

export function seedToolTurn(
  session: Session,
  fields: { readonly turn: number; readonly user: string; readonly tool: string; readonly callId: string; readonly args: string; readonly result: string; readonly usage?: { readonly input: number; readonly output: number } },
): void {
  const { turn } = fields;
  must(session.append("turn/start", { turn }));
  must(session.append("step/start", { turn, step: 0 }));
  must(session.append("user/message", { turn, step: 0, content: [{ type: "text", text: fields.user }] }, { surfaceOp: "append" }));
  must(
    session.append(
      "assistant/message",
      {
        turn,
        step: 0,
        content: [{ type: "tool_use", callId: fields.callId, name: fields.tool, input: fields.args }],
        ...(fields.usage !== undefined ? { usage: fields.usage } : {}),
        stopReason: "stop",
      },
      { surfaceOp: "append" },
    ),
  );
  must(session.append("tool/call", { turn, step: 0, callId: fields.callId, name: fields.tool, arguments: fields.args }));
  must(session.append("tool/result", { turn, step: 0, callId: fields.callId, content: fields.result }, { surfaceOp: "append" }));
  must(session.append("step/end", { turn, step: 0 }));
  must(session.append("turn/end", { turn, reason: { kind: "completed" } }));
}

export function textOf(tokens: number): string {
  return "a".repeat(tokens * 4);
}

function envelope(spec: { readonly type: string; readonly seq: number; readonly data: unknown; readonly surfaceOp?: SurfaceOp }): SessionEvent {
  return {
    type: spec.type,
    seq: spec.seq,
    time: 1,
    data: spec.data,
    ...(spec.surfaceOp !== undefined ? { surfaceOp: spec.surfaceOp } : {}),
  } as never as SessionEvent;
}

export function userNode(seq: number, text: string, op: SurfaceOp = "append"): SurfaceNode {
  const content: ContentBlock[] = [{ type: "text", text }];
  return { seq, event: envelope({ type: "user/message", seq, data: { turn: 0, step: 0, content }, surfaceOp: op }) } as never;
}

export function assistantNode(seq: number, text: string, usage?: unknown): SurfaceNode {
  return {
    seq,
    event: envelope({
      type: "assistant/message",
      seq,
      data: { turn: 0, step: 0, content: [{ type: "text", text }], ...(usage !== undefined ? { usage } : {}), stopReason: "stop" },
      surfaceOp: "append",
    }),
  } as never;
}

export function toolResultNode(seq: number, callId: string, content: string): SurfaceNode {
  return { seq, event: envelope({ type: "tool/result", seq, data: { turn: 0, step: 0, callId, content }, surfaceOp: "append" }) } as never;
}

export function logEvent(type: string, seq: number, data: unknown): SessionEvent {
  return envelope({ type, seq, data });
}

export const sid = (v: string): SessionId => v as SessionId;

export type { Session, SessionStore };
