import type {
  ToolEffects,
  ToolPreparationInvocation,
  ToolExecutionContext,
  PreparedTool,
  PreparedToolRequest,
  ToolCommit,
} from "../planning/types";
import type {
  JsonValue,
  Result,
  Origin,
  PluginInvocation,
  TokenMap,
} from "../../../../core/src/index";
export type JsonObject = Readonly<Record<string, JsonValue>>;
export const toolsErrorCodes = [
  "invalid-input",
  "invalid-schema",
  "unsupported-schema",
  "invalid-output",
  "not-found",
  "name-conflict",
  "access-denied",
  "busy",
  "capacity-exceeded",
  "cancelled",
  "timeout",
  "execution-failed",
  "consumer-failed",
  "closed",
  "stale-plan",
  "resource-busy",
  "admission-busy",
] as const;
export interface ToolsError {
  readonly source: "tools";
  readonly code: (typeof toolsErrorCodes)[number];
  readonly message: string;
}
export type ToolsResult<T> = Result<T, ToolsError>;
export type ToolInputSchema = JsonObject & { readonly type: "object" };
type RequiredNames<S> = S extends { readonly required: readonly (infer K)[] } ? K : never;
type ObjectInput<P, S, D extends readonly unknown[]> = {
  readonly [K in keyof P as K extends RequiredNames<S> ? K : never]: InferSchema<P[K], [...D, 0]>;
} & {
  readonly [K in keyof P as K extends RequiredNames<S> ? never : K]?: InferSchema<P[K], [...D, 0]>;
};
type InferType<T, S, D extends readonly unknown[]> = T extends "object"
  ? S extends { readonly properties: infer P }
    ? ObjectInput<P, S, D>
    : JsonObject
  : T extends "array"
    ? S extends { readonly items: infer I }
      ? readonly InferSchema<I, [...D, 0]>[]
      : readonly JsonValue[]
    : T extends "string"
      ? string
      : T extends "number" | "integer"
        ? number
        : T extends "boolean"
          ? boolean
          : T extends "null"
            ? null
            : JsonValue;
export type InferSchema<S, D extends readonly unknown[] = []> = D["length"] extends 16
  ? JsonValue
  : S extends { readonly const: infer V }
    ? V
    : S extends { readonly enum: readonly (infer V)[] }
      ? V
      : S extends { readonly type: infer T }
        ? InferType<T extends readonly unknown[] ? T[number] : T, S, D>
        : JsonValue;
export type ToolContent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly source:
        | { readonly type: "url"; readonly url: string }
        | { readonly type: "base64"; readonly mediaType: string; readonly data: string };
    };
export interface ToolOutput {
  readonly content: readonly ToolContent[];
  readonly structured?: JsonObject;
  readonly isError?: boolean;
}
export interface ToolDescription {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: ToolInputSchema;
  readonly outputSchema?: ToolInputSchema;
  readonly concurrency: number;
}
export interface ToolRequest {
  readonly name: string;
  readonly callId: string;
  readonly input: JsonObject;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onProgress?: (delta: string, signal: AbortSignal) => void | Promise<void>;
}
export interface ToolsService {
  list(input: Record<never, never>): Promise<ToolsResult<readonly ToolDescription[]>>;
  get(input: { readonly name: string }): Promise<ToolsResult<ToolDescription | null>>;
  watch(input: {
    readonly onChange: () => void;
  }): Promise<ToolsResult<import("../../../../core/src/index").Disposer>>;
  checkPrepared(input: { readonly prepared: PreparedTool }): Promise<ToolsResult<ToolCommit>>;
  prepare(input: ToolRequest): Promise<ToolsResult<PreparedTool>>;
  executePrepared(input: PreparedToolRequest): Promise<ToolsResult<ToolOutput>>;
  discard(input: { readonly prepared: PreparedTool }): Promise<ToolsResult<void>>;
  execute(input: ToolRequest): Promise<ToolsResult<ToolOutput>>;
}
export interface ToolAccess {
  readonly operation: "list" | "get" | "execute";
  readonly tool: ToolDescription;
  readonly origin: Origin;
  readonly input?: JsonObject;
  readonly callId?: string;
}
export interface ToolExecutionLimits {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxProgressBytes: number;
  readonly maxProgressTotalBytes: number;
  readonly maxProgressEvents: number;
  readonly timeoutMs: number;
  readonly consumerTimeoutMs: number;
}
export interface ToolsLimits extends ToolExecutionLimits {
  readonly maxPreparedPlans: number;
  readonly maxActiveRequests: number;
  readonly maxTools: number;
  readonly maxCatalogBytes: number;
}
export type ToolInvocation<
  D extends TokenMap = Record<never, never>,
  O extends TokenMap = Record<never, never>,
> = PluginInvocation<{ requires: D; optional: O }> &
  ToolExecutionContext & {
    readonly callId: string;
    readonly name: string;
    readonly caller: Origin;
    readonly progress: (delta: string) => Promise<ToolsResult<void>>;
  };
export interface ToolPluginOptions<
  S extends ToolInputSchema,
  D extends TokenMap = Record<never, never>,
  O extends TokenMap = Record<never, never>,
> {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: S;
  readonly outputSchema?: ToolInputSchema;
  readonly requires?: D;
  readonly optional?: O;
  readonly concurrency?: number;
  readonly limits?: Partial<ToolExecutionLimits>;
  readonly prepare?: (
    input: InferSchema<S>,
    call: ToolPreparationInvocation<D, O>,
  ) => ToolsResult<ToolEffects> | Promise<ToolsResult<ToolEffects>>;
  readonly execute: (
    input: InferSchema<S>,
    call: ToolInvocation<D, O>,
  ) => ToolsResult<ToolOutput> | Promise<ToolsResult<ToolOutput>>;
}
export interface ToolsOptions {
  readonly access?: "required" | "allow";
  readonly limits?: Partial<ToolsLimits>;
}
