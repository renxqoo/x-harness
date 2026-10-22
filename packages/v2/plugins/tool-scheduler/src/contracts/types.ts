import type { Origin, Result } from "../../../../core/src/index";
import type { JsonObject, ToolOutput, ToolRequest, ToolsError } from "../../../tools/src/index";
export const schedulerErrorCodes = [
  "invalid-input",
  "queue-full",
  "busy",
  "access-denied",
  "dependency-failed",
  "capacity-exceeded",
  "closed",
] as const;
export interface SchedulerError {
  readonly source: "tool-scheduler";
  readonly code: (typeof schedulerErrorCodes)[number];
  readonly message: string;
}
export type SchedulerResult<T> = Result<T, SchedulerError | ToolsError>;
export interface ScheduledCall {
  readonly callId: string;
  readonly name: string;
  readonly input: JsonObject;
  readonly dependsOn?: readonly string[];
  readonly priority?: number;
  readonly timeoutMs?: number;
}
export type ScheduledRequest = ToolRequest & {
  readonly priority?: number;
  readonly mode?: "wait" | "immediate";
};
export interface BatchRequest {
  readonly calls: readonly ScheduledCall[];
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onProgress?: (
    event: { readonly callId: string; readonly delta: string },
    signal: AbortSignal,
  ) => void | Promise<void>;
}
export interface BatchReport {
  readonly results: readonly {
    readonly callId: string;
    readonly result: SchedulerResult<ToolOutput>;
  }[];
}
export interface SchedulerSnapshot {
  readonly running: number;
  readonly queued: number;
  readonly requests: number;
}
export interface ToolSchedulerService {
  execute(input: ScheduledRequest): Promise<SchedulerResult<ToolOutput>>;
  batch(input: BatchRequest): Promise<SchedulerResult<BatchReport>>;
  inspect(input: Record<never, never>): Promise<SchedulerResult<SchedulerSnapshot>>;
}
export interface ScheduleAccess {
  readonly operation: "execute" | "batch";
  readonly origin: Origin;
  readonly calls: readonly ScheduledCall[];
}
export interface SchedulerLimits {
  readonly concurrency: number;
  readonly maxOutstandingCalls: number;
  readonly maxRequests: number;
  readonly maxBatchCalls: number;
  readonly maxInputBytes: number;
  readonly maxResultBytes: number;
  readonly timeoutMs: number;
}
export interface SchedulerOptions {
  readonly access?: "required" | "allow";
  readonly limits?: Partial<SchedulerLimits>;
}
