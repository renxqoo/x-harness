// 插件 API 纯函数 archetype 层（SDK-MIGRATION-P1）：transform/veto/tap × 三域 + 逃生舱。
// 零新语义零新 token——全部为既有 waterfall 的语法糖；next 纪律/洋葱序/payload 形状由
// 框架结构性保证（作者只写业务判断，不可能忘记 next 或写错洋葱方向）。
// 洋葱纪律：veto 一律「先 next 后否决」（tools I2 契约——内层副作用保留，最外层否决胜）。

import type { Context, Disposer } from "@x-harness/core";
import { agentAssistantSettle, agentAssistantStream, agentLlmStream, agentPreStep, agentRequest, agentTurnStopping } from "@x-harness/agent-loop";
import type { AssistantSettlement, Dial } from "@x-harness/agent-loop";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionEvent } from "@x-harness/session";
import type { InboxEntry, SessionEvent } from "@x-harness/session";
import { toolsExecute, toolsPreExecute } from "@x-harness/tools";
import type { ToolCallRequest, ToolOutcome } from "@x-harness/tools";

// —— 上下文域 ——

/** pre-step 改写：fn 收当前生效领取批次（链上前者改写版或原始 claim），输出即落账版 */
export function transformMessages(ctx: Context, fn: (claim: readonly InboxEntry[]) => InboxEntry[] | Promise<readonly InboxEntry[]>): Disposer {
  return ctx.on(agentPreStep, async (payload, next) => {
    const decision = await next(payload);
    if ((decision as { kind?: string }).kind !== "enter") return decision;
    const current = (decision as { messages?: readonly InboxEntry[] }).messages ?? payload.claim;
    return { kind: "enter", messages: await fn(current) } as never;
  });
}

/** pre-step 否决：fn 返回 reason = reject（先 next 后否决——内层副作用保留） */
export function vetoStep(ctx: Context, fn: (claim: readonly InboxEntry[]) => string | undefined): Disposer {
  return ctx.on(agentPreStep, async (payload, next) => {
    const outcome = await next(payload);
    const reason = fn(payload.claim);
    return reason !== undefined ? ({ kind: "reject", reason } as never) : outcome;
  });
}

/** assistant 落账前纠：输出契约只 content/stopReason（interrupted 内核独占） */
export function transformAssistant(ctx: Context, fn: (s: AssistantSettlement) => AssistantSettlement): Disposer {
  return ctx.on(agentAssistantSettle, async (payload, next) => {
    const out = await next(payload);
    const transformed = fn(out);
    return { content: transformed.content, stopReason: transformed.stopReason } as never;
  });
}

// —— 工具域 ——

/** 工具否决器：返回 deny 则拦截（先 next 后 deny——I2；最外层 deny 胜） */
export function vetoTools(
  ctx: Context,
  fn: (call: { readonly callId: string; readonly name: string; readonly args: unknown; readonly session?: never }) => { readonly kind: "deny"; readonly reason: string } | undefined,
): Disposer {
  return ctx.on(toolsPreExecute, async (payload, next) => {
    const inner = await next(payload);
    const deny = fn(payload as never);
    return (deny ?? inner) as never;
  });
}

/** 工具输出变换（execute 后处理）。注册序（收口审查 4.3）：缺省外层（见超时后处理后的
 *  outcome）；需内层视角传 { prepend: true }。 */
export function transformToolResult(
  ctx: Context,
  fn: (outcome: ToolOutcome, request: ToolCallRequest) => ToolOutcome,
  opts?: { readonly prepend?: boolean },
): Disposer {
  return ctx.on(toolsExecute, async (request, next) => fn(await next(request), request) as never, opts);
}

// —— 循环域 ——

/** 拨号参数变换（模型/温度/thinking 等） */
export function transformDial(ctx: Context, fn: (dial: Dial) => Dial): Disposer {
  return ctx.on(agentRequest, async (payload, next) => fn(await next(payload)) as never);
}

/** agent 层流包裹：注入/截断/变换帧（每次调用须返回新迭代器——幂等契约） */
export function wrapStream(ctx: Context, fn: (stream: AsyncIterable<LlmChunk>, request: LlmRequest) => AsyncIterable<LlmChunk>): Disposer {
  return ctx.on(agentLlmStream, async (payload, next) => fn(await next(payload), payload.request) as never);
}

// —— 观察类（tap：只读副作用）——

/** assistant 结算观察（settle 后、落账前的形态） */
export function tapAssistant(ctx: Context, fn: (s: AssistantSettlement) => void): Disposer {
  return ctx.on(agentAssistantSettle, async (payload, next) => {
    const out = await next(payload);
    fn(out);
    return out;
  });
}

/** 工具调用观察（请求与结果） */
export function tapToolCalls(ctx: Context, fn: (request: ToolCallRequest, outcome: ToolOutcome) => void): Disposer {
  return ctx.on(toolsExecute, async (request, next) => {
    const outcome = await next(request);
    fn(request, outcome);
    return outcome;
  });
}

/** 流帧观察（实时面） */
export function tapStream(ctx: Context, fn: (frame: unknown) => void): Disposer {
  return ctx.on(agentAssistantStream, (payload) => {
    fn((payload as { frame?: unknown }).frame);
  });
}

/** turn 终态观察 */
export function tapTurnEnd(ctx: Context, fn: () => void): Disposer {
  return ctx.on(agentTurnStopping, () => fn());
}

// —— 逃生舱 ——

/** 原始日志广播观察（高频同步面——三红线：回调须 O(1)；无过滤参数收全量；异常进 sink 静默。
 *  默认先用领域面，此面仅在领域面表达不了时用。） */
export function tapSessionEvents(ctx: Context, fn: (event: SessionEvent) => void): Disposer {
  return ctx.on(sessionEvent, (payload) => fn(payload.event));
}
