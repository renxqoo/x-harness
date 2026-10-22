import type { ServiceToken, JsonValue } from "../../../../core/src/index";
import type { LlmMessage, JsonObject } from "./message-types";
import type {
  LlmEvent,
  LlmSummary,
  LlmResponse,
  FinishReason,
  ProviderEvent,
  LlmOutputBlock,
} from "./event-types";
import type { LlmResult } from "./error-types";
export interface LlmTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly strict?: boolean;
}
export type ProviderTool =
  | { readonly type: "web-search"; readonly allowedDomains?: readonly string[] }
  | {
      readonly type: "file-search";
      readonly vectorStoreIds: readonly string[];
      readonly maxResults?: number;
    };
export type OutputFormat =
  | { readonly type: "text" | "json" }
  | {
      readonly type: "json-schema";
      readonly name: string;
      readonly schema: JsonObject;
      readonly strict?: boolean;
    };
export interface LlmRequest {
  readonly provider?: string;
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly tools?: readonly LlmTool[];
  readonly providerTools?: readonly ProviderTool[];
  readonly toolChoice?: "auto" | "none" | "required" | { readonly name: string };
  readonly output?: OutputFormat;
  readonly reasoning?: {
    readonly effort?: string;
    readonly budgetTokens?: number;
    readonly display?: "text" | "summary" | "hidden";
  };
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number;
  readonly stop?: readonly string[];
  readonly providerOptions?: JsonObject;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
export interface LlmStreamInput extends LlmRequest {
  readonly onEvent: (event: LlmEvent, signal: AbortSignal) => void | Promise<void>;
}
export interface ModelReference {
  readonly provider?: string;
  readonly model: string;
}
export interface ModelDescription {
  readonly protocol: string;
  readonly model: string;
  readonly canonicalModel?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly input: readonly ("text" | "image" | "document" | "search-result")[];
  readonly developer: boolean;
  readonly tools: boolean;
  readonly citations: boolean;
  readonly output: readonly ("text" | "json" | "json-schema")[];
  readonly providerTools: readonly ("web-search" | "file-search")[];
  readonly reasoning?: {
    readonly efforts: readonly string[];
    readonly budget: boolean;
    readonly display: readonly ("text" | "summary" | "hidden")[];
  };
}
export interface LlmService {
  stream(input: LlmStreamInput): Promise<LlmResult<LlmSummary>>;
  generate(input: LlmRequest): Promise<LlmResult<LlmResponse>>;
  describe(input: ModelReference): Promise<LlmResult<ModelDescription>>;
}
export interface ProviderEnd {
  readonly reason: FinishReason;
  readonly rawReason?: string;
}
export interface ProviderStreamInput {
  readonly request: LlmRequest;
  readonly provider: string;
  readonly signal: AbortSignal;
  readonly onEvent: (event: ProviderEvent) => Promise<LlmResult<void>>;
}
export interface LlmProviderService {
  stream(input: ProviderStreamInput): Promise<LlmResult<ProviderEnd>>;
  describe(input: {
    readonly model: string;
    readonly signal?: AbortSignal;
  }): Promise<LlmResult<ModelDescription>>;
}
export type ProviderMap = Readonly<Record<string, ServiceToken<LlmProviderService>>>;
export interface LlmLimits {
  readonly maxActiveRequests: number;
  readonly maxProviders: number;
  readonly maxInputBytes: number;
  readonly maxMessages: number;
  readonly maxTools: number;
  readonly maxBlocks: number;
  readonly maxEventBytes: number;
  readonly maxToolInputBytes: number;
  readonly maxContinuationBytes: number;
  readonly maxOutputBytes: number;
  readonly maxEvents: number;
  readonly maxJsonDepth: number;
  readonly maxJsonNodes: number;
  readonly timeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly consumerTimeoutMs: number;
}
export interface LlmOptions {
  readonly providers: ProviderMap;
  readonly defaultProvider?: string;
  readonly limits?: Partial<LlmLimits>;
}
export interface LlmRunInput {
  readonly request: LlmRequest;
  readonly onEvent: LlmStreamInput["onEvent"];
  readonly collect: boolean;
}
export interface LlmRunOutput {
  readonly summary: LlmSummary;
  readonly content?: readonly LlmOutputBlock[];
  readonly output?: JsonValue;
}
export interface LlmStream extends AsyncIterable<LlmEvent> {
  readonly result: Promise<LlmResult<LlmSummary>>;
}
