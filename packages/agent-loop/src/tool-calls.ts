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
  readonly allowedTools?: readonly string[];
  readonly emitToolStream?: (callId: string, delta: string) => void;
}

const ABORTED_BEFORE_DISPATCH = "tool call aborted before dispatch";

export const TRUNCATED_TOOL_MESSAGE = "truncated: not executed";

export function isTruncatedArguments(input: string): boolean {
  if (input === "") return true;
  try {
    JSON.parse(input);
    return false;
  } catch {
    return true;
  }
}

function onOutputOf(deps: SchedulerDeps, callId: string): ((delta: string) => void) | undefined {
  if (deps.emitToolStream === undefined) return undefined;
  return (delta: string) => {
    try {
      deps.emitToolStream?.(callId, delta);
    } catch {
    }
  };
}

interface DenyCheck {
  readonly session: Session;
  readonly call: ToolCallSpec;
  readonly allowed: Set<string> | undefined;
  readonly turn: number;
  readonly step: number;
}

export function mustAppendPair(
  session: Session,
  at: { readonly turn: number; readonly step: number },
  spec: { readonly callId: string; readonly name: string; readonly arguments: string; readonly content: string },
): void {
  mustAppend(session, "tool/call", { ...at, callId: spec.callId, name: spec.name, arguments: spec.arguments });
  mustAppendSurface(session, "tool/result", { ...at, callId: spec.callId, content: spec.content, isError: true, synthetic: true });
}

function denyNotAllowed(check: DenyCheck): boolean {
  if (check.allowed === undefined || check.allowed.has(check.call.name)) return false;
  const at = { turn: check.turn, step: check.step };
  mustAppend(check.session, "tool/call", { ...at, callId: check.call.callId, name: check.call.name, arguments: check.call.arguments });
  mustAppendSurface(check.session, "tool/result", { ...at, callId: check.call.callId, content: `tool-not-allowed:${check.call.name}`, isError: true });
  return true;
}

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
    return raw;
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
  const allowed = deps.allowedTools === undefined ? undefined : new Set(deps.allowedTools);

  let index = 0;
  while (index < calls.length) {
    if (signal.aborted) {
      for (const call of calls.slice(index)) {
        mustAppend(session, "tool/call", { turn, step, callId: call.callId, name: call.name, arguments: call.arguments });
        mustAppendSurface(session, "tool/result", { turn, step, callId: call.callId, content: ABORTED_BEFORE_DISPATCH, isError: true });
      }
      return { concludesTurn: ledger.concludesTurn, additionalContexts: ledger.contexts };
    }
    const head = calls[index] as ToolCallSpec;
    if (denyNotAllowed({ session, call: head, allowed, turn, step })) {
      index += 1;
      continue;
    }
    const headArgs = parseArgs(head.arguments);
    if (registry.concurrencyOf(head.name, headArgs) !== "parallel") {
      await runOne(deps, head, ledger);
      index += 1;
      continue;
    }
    const pool: ToolCallSpec[] = [];
    while (index < calls.length && pool.length < maxParallel) {
      const candidate = calls[index] as ToolCallSpec;
      if (allowed !== undefined && !allowed.has(candidate.name)) break;
      const candidateArgs = parseArgs(candidate.arguments);
      if (registry.concurrencyOf(candidate.name, candidateArgs) !== "parallel") break;
      pool.push(candidate);
      index += 1;
    }
    for (const call of pool) {
      mustAppend(session, "tool/call", { turn, step, callId: call.callId, name: call.name, arguments: call.arguments });
    }
    const outcomes = await Promise.all(
      pool.map((call) => {
        const onOutput = onOutputOf(deps, call.callId);
        return registry.dispatch({
          callId: call.callId,
          name: call.name,
          args: parseArgs(call.arguments),
          signal,
          session: session.id,
          ...(onOutput !== undefined ? { onOutput } : {}),
        });
      }),
    );
    for (let i = 0; i < pool.length; i++) {
      const outcome = outcomes[i];
      if (outcome !== undefined) commitOutcome(pool[i] as ToolCallSpec, outcome, ledger);
    }
  }
  return { concludesTurn: ledger.concludesTurn, additionalContexts: ledger.contexts };
}

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
  const onOutput = onOutputOf(deps, call.callId);
  const outcome = await deps.registry.dispatch({
    callId: call.callId,
    name: call.name,
    args: parseArgs(call.arguments),
    signal: deps.signal,
    session: ledger.session.id,
    ...(onOutput !== undefined ? { onOutput } : {}),
  });
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
