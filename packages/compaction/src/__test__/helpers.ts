// 测试装置：脚本化假 LlmRuntime + 会话播种 + 世界装配（packages/compaction 专用，
// 不跨包引用别的包 __test__）。

import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest, LlmRuntime } from "@x-harness/llm";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { ContentBlock, Session, SessionEvent, SessionId, SessionStore, SurfaceNode, SurfaceOp } from "@x-harness/session";

export function textScript(text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

export function thinkingOnlyScript(text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "thinking-delta", text };
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

export function truncatedScript(text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "finish", finish: { kind: "max-tokens" } };
  })();
}

export function errorScript(code?: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "finish", finish: { kind: "error", message: "summarizer boom", ...(code !== undefined ? { code } : {}) } };
  })();
}

export function emptyScript(): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

/** 慢速流：吐一段 delta → 等待 ms → finish（单飞行窗口用） */
export function slowScript(text: string, ms: number): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

/** 静默挂死流：吐一段 delta 后永悬（看门狗面） */
export function hangScript(firstText: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text: firstText };
    await new Promise(() => {});
    yield { type: "finish", finish: { kind: "stop" } };
  })();
}

export interface FakeLlm {
  readonly runtime: LlmRuntime;
  readonly calls: LlmRequest[];
  readonly scripts: Array<AsyncGenerator<LlmChunk>>;
}

export function fakeLlm(): FakeLlm {
  const calls: LlmRequest[] = [];
  const scripts: Array<AsyncGenerator<LlmChunk>> = [];
  const runtime: LlmRuntime = {
    registerAdapter: () => () => {},
    contextWindowOf: () => undefined,
    stream: (request) => {
      calls.push(request);
      const script = scripts.shift();
      return script ?? emptyScript();
    },
  };
  return { runtime, calls, scripts };
}

export const BASE_OPTIONS = {
  contextWindow: 1_000,
  reserveTokens: 100,
  keepRecentTokens: 1,
  summarizer: { model: "sum-model", contextWindow: 100_000 },
} as const;

export async function makeWorld(pluginOptions?: Record<string, unknown>) {
  const ctx = createContext();
  const fake = fakeLlm();
  const { createCompactionPlugin } = await import("../plugin.ts");
  const plugin = createCompactionPlugin({ ...BASE_OPTIONS, ...pluginOptions } as never);
  await loadPlugins(ctx, [sessionPlugin, plugin]);
  ctx.provide(llmRuntime, fake.runtime); // waitFor 停靠（llm 晚装合法形态）
  return { ctx, store: ctx.use(sessionStore), llm: fake };
}

function must(result: { ok: boolean; reason?: string }): void {
  if (!result.ok) throw new Error(`append failed: ${String(result.reason)}`);
}

export function seedTurn(
  session: Session,
  fields: { readonly turn: number; readonly user: string; readonly assistant: { readonly text: string; readonly usage?: { readonly input: number; readonly output: number } } },
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
        ...(fields.assistant.usage !== undefined ? { usage: fields.assistant.usage } : {}),
        stopReason: "stop",
      },
      { surfaceOp: "append" },
    ),
  );
  must(session.append("step/end", { turn, step: 0 }));
  must(session.append("turn/end", { turn, reason: { kind: "completed" } }));
}

/** 从拨号记录提取 user 提示词文本（messages[0] 为 system 提示词） */
export function promptOf(call: LlmRequest | undefined): string {
  const message = call?.messages.find((item) => item.role === "user");
  const block = message !== undefined && "content" in message ? message.content[0] : undefined;
  return block !== undefined && block.type === "text" ? block.text : "";
}

export function seedSystem(session: Session, text: string): void {
  must(session.append("system/message", { turn: 0, step: 0, text }, { surfaceOp: "append" }));
}

/** n token 的 ASCII 文本（len/4 口径恰好 n） */
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
    event: envelope({ type: "assistant/message", seq, data: { turn: 0, step: 0, content: [{ type: "text", text }], ...(usage !== undefined ? { usage } : {}), stopReason: "stop" }, surfaceOp: "append" }),
  } as never;
}

export function toolResultNode(seq: number, callId: string, content: string): SurfaceNode {
  return { seq, event: envelope({ type: "tool/result", seq, data: { turn: 0, step: 0, callId, content }, surfaceOp: "append" }) } as never;
}

export function systemNode(seq: number, text: string): SurfaceNode {
  return { seq, event: envelope({ type: "system/message", seq, data: { turn: 0, step: 0, text }, surfaceOp: "append" }) } as never;
}

export function logEvent(type: string, seq: number, data: unknown): SessionEvent {
  return envelope({ type, seq, data });
}

export const sid = (v: string): SessionId => v as SessionId;

export type { Context, Session, SessionStore };
