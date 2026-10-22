import type { Result, Origin, OwnerInspection, JsonValue } from "../../../../core/src/index";
import type {
  LlmRequest,
  LlmResponse,
  LlmEvent,
  LlmUsage,
  FinishReason,
  LlmMessage,
} from "../../../llm/src/index";
import type { ToolOutput } from "../../../tools/src/index";
export const agentErrorCodes = Object.freeze([
  "invalid-input",
  "invalid-output",
  "capacity-exceeded",
  "busy",
  "closed",
  "access-denied",
  "context-failed",
  "model-failed",
  "invalid-model-output",
  "checkpoint-failed",
  "tool-batch-failed",
  "tool-outcome-unknown",
  "consumer-failed",
  "cancelled",
  "timeout",
] as const);
export interface AgentError {
  readonly source: "agent-loop";
  readonly code: (typeof agentErrorCodes)[number];
  readonly runId?: string;
  readonly step?: number;
  readonly toolsMayHaveRun?: boolean;
}
export type AgentResult<T> = Result<T, AgentError>;
export type AgentStopReason = "model" | "policy" | "step-limit" | "tool-limit";
export interface AgentCaller {
  readonly origin: Origin;
  readonly initiator: OwnerInspection;
}
export type AgentModelRequest = Omit<LlmRequest, "signal">;
export interface AgentContext {
  readonly runId: string;
  readonly step: number;
  readonly caller: AgentCaller;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly request: AgentModelRequest;
}
export interface AgentAccess extends AgentContext {
  readonly phase: "context" | "model" | "tools";
}
export type AgentToolReceipt =
  | { readonly callId: string; readonly outcome: "returned"; readonly output: ToolOutput }
  | {
      readonly callId: string;
      readonly outcome: "unknown";
      readonly error: { readonly source: string; readonly code: string };
    };
export type AgentCheckpoint = AgentContext & {
  readonly response: LlmResponse;
  readonly messages: readonly LlmMessage[];
} & (
    | { readonly phase: "response"; readonly results?: never }
    | { readonly phase: "tools"; readonly results: readonly AgentToolReceipt[] }
  );
export interface AgentRun {
  readonly runId: string;
  readonly steps: number;
  readonly toolCalls: number;
  readonly messages: readonly LlmMessage[];
  readonly response: LlmResponse;
  readonly stopReason: AgentStopReason;
  readonly usage: readonly { readonly step: number; readonly usage: LlmUsage }[];
}
export interface AgentRunInput extends Omit<LlmRequest, "tools"> {
  readonly tools?: readonly string[];
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly runId?: string;
  readonly onEvent?: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>;
}
export interface AgentLoopService {
  run(input: AgentRunInput): Promise<AgentResult<AgentRun>>;
}
export const agentEventTypes = Object.freeze([
  "start",
  "step-start",
  "model-event",
  "tool-progress",
  "step-end",
  "finish",
  "error",
] as const);
export type AgentEventBody =
  | { readonly type: "start"; readonly model: string }
  | { readonly type: "step-start"; readonly step: number }
  | { readonly type: "model-event"; readonly step: number; readonly event: LlmEvent }
  | {
      readonly type: "tool-progress";
      readonly step: number;
      readonly callId: string;
      readonly delta: string;
    }
  | {
      readonly type: "step-end";
      readonly step: number;
      readonly reason: FinishReason;
      readonly toolCalls: number;
    }
  | {
      readonly type: "finish";
      readonly stopReason: AgentStopReason;
      readonly steps: number;
      readonly toolCalls: number;
    }
  | { readonly type: "error"; readonly error: AgentError };
export type AgentEvent = AgentEventBody & { readonly runId: string; readonly sequence: number };
export interface AgentLimits {
  readonly maxActiveRuns: number;
  readonly maxSteps: number;
  readonly maxToolCalls: number;
  readonly maxTools: number;
  readonly maxMessages: number;
  readonly maxTranscriptBytes: number;
  readonly maxEventBytes: number;
  readonly maxEventTotalBytes: number;
  readonly maxEvents: number;
  readonly timeoutMs: number;
  readonly consumerTimeoutMs: number;
}
export interface AgentOptions {
  readonly access?: "required" | "allow";
  readonly limits?: Partial<AgentLimits>;
}
export interface AgentStream extends AsyncIterable<AgentEvent> {
  readonly result: Promise<AgentResult<AgentRun>>;
}
