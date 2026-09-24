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
  /** 工具白名单（缺省=全部）；白名单外调用拦截在执行面并配对落账 */
  readonly allowedTools?: readonly string[];
  /** 工具增量输出发射面（agentToolStream——自包裹 try/catch：观察面异常不杀工具结果） */
  readonly emitToolStream?: (callId: string, delta: string) => void;
}

const ABORTED_BEFORE_DISPATCH = "tool call aborted before dispatch";

/** 截断配对内核文案（docs/WORK-ERROR-RECOVERY.md C3）：协议性短事实——判别符式陈述，
 *  策略（行为指令、重发引导、拆分建议）归文案插件（@x-harness/truncation-messages 的
 *  替换性 content）。插件缺席时本短事实即合成 result 全文（保底非死代码——「无插件世界」
 *  测试钉死）。 */
export const TRUNCATED_TOOL_MESSAGE = "truncated: not executed";

/** 输出截断的 tool_use 参数判定：input 是 tool/call 契约的 arguments 原文串。
 *  "" = 零字符截断；JSON.parse 失败 = 半截；成功（含非 object 的合法 JSON）= 完整
 *  ——非 object 合法 JSON 是模型 bug 不是截断，归既有 TypeBox 违规回显自纠路径。
 *  前置契约（docs/TRUNCATED-TOOL-RESCUE.md 层 1 前置）：llm 层 pi-events 出口保证截断
 *  终态下发缓冲原文（未经 pi-ai partial-json 修补）——本判定才可依赖 JSON.parse 失败。 */
export function isTruncatedArguments(input: string): boolean {
  if (input === "") return true;
  try {
    JSON.parse(input);
    return false;
  } catch {
    return true;
  }
}

/** onOutput 构造（池/排他共用）：调度方发射面自包裹——观察者异常不得杀死工具执行 */
function onOutputOf(deps: SchedulerDeps, callId: string): ((delta: string) => void) | undefined {
  if (deps.emitToolStream === undefined) return undefined;
  return (delta: string) => {
    try {
      deps.emitToolStream?.(callId, delta);
    } catch {
      /* 观察面失败静默收敛：结果权威在返回值 */
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

/** 截断/拒绝共用的配对落账原语：tool/call 非 surface（账面）+ tool/result surface 通道
 *  （投影）——双通道缺一不可（缺 tool/result 投影则配对失效、缺 tool/call 则 repair 误判未启动）。 */
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
  const allowed = deps.allowedTools === undefined ? undefined : new Set(deps.allowedTools);

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
    if (denyNotAllowed({ session, call: head, allowed, turn, step })) {
      index += 1;
      continue;
    }
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
      if (allowed !== undefined && !allowed.has(candidate.name)) break; // 白名单外不进池（下一轮头部拦截落账）
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
