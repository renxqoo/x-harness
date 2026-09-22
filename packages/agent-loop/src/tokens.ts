// Agent-Loop 件 7 token（docs/AGENT-LOOP-DRIVER.md §1.2）。emit 三 token freeze=none（高频/预冻语义）。

import { defineEvent, defineSerial, defineWaterfall } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";
import type { ContentBlock, InboxEntry } from "@x-harness/session";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";

export const agentStatus = defineEvent<{ readonly session: SessionId; readonly status: "idle" | "running" }>("agent/status", {
  freeze: "none",
});

export const agentError = defineEvent<{ readonly session: SessionId; readonly turn: number; readonly message: string }>(
  "agent/error",
  { freeze: "none" },
);

export type AssistantStreamFrame =
  | { readonly phase: "start" }
  | { readonly phase: "chunk"; readonly kind: "text" | "thinking"; readonly text: string }
  | { readonly phase: "end"; readonly kind: "message" | "attempt" };

export const agentAssistantStream = defineEvent<{
  readonly session: SessionId;
  readonly turn: number;
  readonly step: number;
  readonly frame: AssistantStreamFrame;
}>("agent/assistant-stream", { freeze: "none" });

/** 工具执行增量输出（BATCH2-DESIGN §2）：实时观察面——不进 WAL（结果权威 =
 *  tool/result），宿主桥接消费（wire 帧 + 在途快照喂入）。delta 为原始字节流口径
 *  （ANSI 清洗是结算时态——escape 序列可跨 chunk，逐块清洗会截坏序列） */
export const agentToolStream = defineEvent<{
  readonly session: SessionId;
  readonly callId: string;
  readonly delta: string;
}>("agent/tool-stream", { freeze: "none" });

/** F0①：enter 可携重写消息（落账走重写版——「模型可见必落盘」保持：重写版即日志版）；
 *  改写须保留 entry.origin——带 origin 条目材料化为 agent/message（AGENT-MESSAGE §4C）；
 *  step0 改写为空 = 闭 turn（领取项被中间件显式清除）。
 *  reject.reason 声明为强形态；waterfall 不校验输出形状——内核按弱形态防御
 *  （null/undefined/垃圾决策在 beginStep 形状收窄，如实按无 reason 落）。 */
export type PreStepDecision =
  | { readonly kind: "enter" }
  | { readonly kind: "enter"; readonly messages: readonly InboxEntry[] }
  | { readonly kind: "reject"; readonly reason: string };

export const agentPreStep = defineWaterfall<
  {
    readonly session: SessionId;
    readonly turn: number;
    readonly step: number;
    /** 全对话史投影（只读观察面——改写依据 claim；SurfaceMessage 判别联合——非 unknown[]） */
    readonly messages: readonly import("@x-harness/session").SurfaceMessage[];
    /** 本步领取的批次（改写决策的输入与替代对象——收口审查 1.1：同名字段两种语义，拆开） */
    readonly claim: readonly InboxEntry[];
    readonly signal: AbortSignal;
  },
  PreStepDecision
>("agent/pre-step");

export interface Dial {
  readonly model: string;
  readonly provider?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly thinking?: import("@x-harness/llm").ThinkingLevel;
}

export const agentRequest = defineWaterfall<
  { readonly session: SessionId; readonly turn: number; readonly step: number; readonly dial: Dial; readonly signal: AbortSignal },
  Dial
>("agent/request");

export interface RequestFailure {
  readonly message: string;
  readonly code?: string;
  /** 429/503 的 Retry-After（毫秒）——重试件快车道（docs/LLM.md §1.2） */
  readonly retryAfterMs?: number;
}

export const agentRequestError = defineWaterfall<
  {
    readonly session: SessionId;
    readonly turn: number;
    readonly step: number;
    readonly failure: RequestFailure;
    readonly signal: AbortSignal;
  },
  /** retry 可携 dial 补丁（pre-stable 扩展——plugin-examples ⑨ dogfood 发现：重试不重派
   *  agentRequest，降级类插件无处改 retry 的模型；补丁在重试分支就地合并） */
  { readonly kind: "retry"; readonly dial?: Partial<Dial> } | undefined
>("agent/request-error");

export const agentTurnStopping = defineSerial<{ readonly session: SessionId; readonly turn: number; readonly signal: AbortSignal }>(
  "agent/turn-stopping",
);

/** 收束窗口（docs/AGENT-MESSAGE.md / docs/OUTPUT-TOKEN-CONTINUATION.md 契约）：无工具 settle
 *  即将结束 turn 的**通用时点**（scheduleTools flow none 之后、settleConclude 之前）——内核
 *  不识「截断」，何时续跑的判定完全归插件。「tool_use 在场不续跑」由结构保证（带工具的
 *  settle 执行工具进下一步，收束点不可达）。无应答（undefined）→ 现行收束路径原样（真
 *  opt-in）。中间件纪律：必须调 next；放弃用 fail 应答而非 throw；让位 = 透传下游。 */
export type TurnConcludeDecision =
  | { readonly kind: "resume"; readonly source: string; readonly instruction: string }
  | { readonly kind: "fail"; readonly message: string; readonly code: string };

export interface TurnConcludePayload {
  readonly session: SessionId;
  readonly turn: number;
  readonly step: number;
  readonly stopReason: "stop" | "max-tokens";
  readonly content: readonly ContentBlock[];
  readonly rawReason?: string;
  readonly signal: AbortSignal;
}

export const agentTurnConclude = defineWaterfall<TurnConcludePayload, TurnConcludeDecision | undefined>("agent/turn-conclude");

/** F0②：assistant 落账前纠（幻觉强形态）——settle 与 append 之间；落的是改写后版本 */
export interface AssistantSettlement {
  readonly content: readonly ContentBlock[];
  readonly stopReason: "stop" | "max-tokens";
  readonly interrupted?: true;
}

export const agentAssistantSettle = defineWaterfall<
  {
    readonly session: SessionId;
    readonly turn: number;
    readonly step: number;
    readonly content: readonly ContentBlock[];
    readonly stopReason: "stop" | "max-tokens";
    readonly interrupted?: true;
    readonly signal: AbortSignal;
  },
  AssistantSettlement
>("agent/assistant-settle");

/** F0③（收口审查 3.1 处置：改名避撞——@x-harness/llm 已有 root 层全局 "llm/stream"）：
 *  本面是 **agent 层**流包裹（per-agent 包裹/截断/注入帧；final = llm.stream）；
 *  全局回放/路由类拦截用 llm 包的 llm/stream（root 层，docs/LLM.md §）。两层串联：
 *  本面 final 内的 runtime 调用再经全局面。settle 仍以落账版为准（流拦截只影响实时面）。 */
export const agentLlmStream = defineWaterfall<{ readonly request: LlmRequest }, AsyncIterable<LlmChunk>>("agent/llm-stream");
