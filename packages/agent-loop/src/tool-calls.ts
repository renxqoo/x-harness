// 工具调度（docs/AGENT-LOOP-DRIVER.md §1.5）：排他屏障 + 并行池（上限）；tool/call 先落、
// dispatch 并发、tool/result 按 model 序落账；abort 未启动合成结果；content 截断。

import type { ContentBlock, Session } from "@x-harness/session";
import type { ToolRegistry } from "@x-harness/tools";
import type { SessionEvent } from "@x-harness/session";

export interface ToolCallSpec {
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ToolCallOutcomeCollected {
  readonly concludesTurn: boolean;
  readonly additionalContexts: ContentBlock[];
}

export interface SchedulerDeps {
  readonly session: Session;
  readonly registry: ToolRegistry;
  readonly signal: AbortSignal;
  readonly maxParallel: number;
  readonly maxResultChars: number;
  readonly turn: number;
  readonly step: number;
}

const ABORTED_BEFORE_DISPATCH = "tool call aborted before dispatch";

/** 落账失败即 throw：配对不变量（tool/call↔tool/result）不容静默丢失；逃逸由 driver 收 error turn/end */
function mustAppend(session: Session, type: string, data: unknown): void {
  const result = session.append(type as never, data as never);
  if (!result.ok) throw new Error(`append-failed:${type}:${result.reason}`);
}

function mustAppendSurface(session: Session, type: string, data: unknown): void {
  const result = session.append(type as never, data as never, { surfaceOp: "append" } as never);
  if (!result.ok) throw new Error(`append-failed:${type}:${result.reason}`);
}

function parseArgs(raw: string): unknown {
  if (raw === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw; // 原文保留：违规回显让模型自纠
  }
}

function truncate(content: string, limit: number): string {
  return content.length <= limit ? content : `${content.slice(0, limit)}…[truncated]`;
}

export async function executeToolCalls(
  deps: SchedulerDeps,
  calls: readonly ToolCallSpec[],
): Promise<ToolCallOutcomeCollected> {
  const { session, registry, signal, maxParallel, turn, step } = deps;
  const ledger: Ledger = { session, turn, step, maxResultChars: deps.maxResultChars, contexts: [], concludesTurn: false };

  let index = 0;
  while (index < calls.length) {
    if (signal.aborted) {
      // 剩余未启动调用：合成错误结果（保证重放/修复有效）
      for (const call of calls.slice(index)) {
        mustAppend(session, "tool/call", { turn, step, callId: call.callId, name: call.name, arguments: call.arguments });
        mustAppendSurface(session, "tool/result", { turn, step, callId: call.callId, content: ABORTED_BEFORE_DISPATCH, isError: true });
      }
      return { concludesTurn: ledger.concludesTurn, additionalContexts: ledger.contexts };
    }
    const head = calls[index] as ToolCallSpec;
    const headArgs = parseArgs(head.arguments);
    if (registry.concurrencyOf(head.name, headArgs) !== "parallel") {
      // 排他屏障：单独执行
      await runOne(deps, head, ledger);
      index += 1;
      continue;
    }
    // 连续 parallel 段进池（上限切分）
    const pool: ToolCallSpec[] = [];
    while (index < calls.length && pool.length < maxParallel) {
      const candidate = calls[index] as ToolCallSpec;
      const candidateArgs = parseArgs(candidate.arguments);
      if (registry.concurrencyOf(candidate.name, candidateArgs) !== "parallel") break;
      pool.push(candidate);
      index += 1;
    }
    // 本组 tool/call 按 model 序先落账 → 并发 dispatch → 结果按 model 序落账
    for (const call of pool) {
      mustAppend(session, "tool/call", { turn, step, callId: call.callId, name: call.name, arguments: call.arguments });
    }
    const outcomes = await Promise.all(
      pool.map((call) => registry.dispatch({ callId: call.callId, name: call.name, args: parseArgs(call.arguments), signal })),
    );
    for (let i = 0; i < pool.length; i++) {
      const outcome = outcomes[i];
      if (outcome !== undefined) commitOutcome(pool[i] as ToolCallSpec, outcome, ledger);
    }
  }
  return { concludesTurn: ledger.concludesTurn, additionalContexts: ledger.contexts };
}

/** 调度台账：tool/result 落账 + concludesTurn/contexts 归集 */
interface Ledger {
  readonly session: Session;
  readonly turn: number;
  readonly step: number;
  readonly maxResultChars: number;
  readonly contexts: ContentBlock[];
  concludesTurn: boolean;
}

async function runOne(deps: SchedulerDeps, call: ToolCallSpec, ledger: Ledger): Promise<void> {
  mustAppend(ledger.session, "tool/call", { turn: ledger.turn, step: ledger.step, callId: call.callId, name: call.name, arguments: call.arguments });
  const outcome = await deps.registry.dispatch({ callId: call.callId, name: call.name, args: parseArgs(call.arguments), signal: deps.signal });
  commitOutcome(call, outcome, ledger);
}

function commitOutcome(
  call: ToolCallSpec,
  outcome: { readonly content: string; readonly isError?: true; readonly concludesTurn?: true; readonly additionalContexts?: readonly { readonly content: readonly { readonly type: "text"; readonly text: string }[] }[] },
  ledger: Ledger,
): void {
  mustAppendSurface(ledger.session, "tool/result", {
    turn: ledger.turn,
    step: ledger.step,
    callId: call.callId,
    content: truncate(outcome.content, ledger.maxResultChars),
    ...(outcome.isError === true ? { isError: true } : {}),
  });
  if (outcome.concludesTurn === true) ledger.concludesTurn = true;
  for (const context of outcome.additionalContexts ?? []) {
    for (const block of context.content) ledger.contexts.push({ type: "text", text: block.text });
  }
}

export type { SessionEvent };
