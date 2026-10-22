import type {
  JsonObject,
  LlmLimits,
  LlmResult,
  ProviderEvent,
  ProviderEnd,
  LlmRequest,
  ModelDescription,
} from "../../llm/src/contracts";
import type { LlmControl } from "../../llm/src/provider";
export type HttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface HttpOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: HttpFetch;
  readonly now?: () => number;
}
export interface HttpConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetch: HttpFetch;
  readonly now: () => number;
}
export interface SseFrame {
  readonly event: string;
  readonly data: string;
}
export interface DecodedFrame {
  readonly events: readonly ProviderEvent[];
  readonly stop: boolean;
}
export interface ProtocolDecoder {
  accept(frame: SseFrame): LlmResult<DecodedFrame>;
  finish(): LlmResult<ProviderEnd>;
}
export interface HttpRequest {
  readonly config: HttpConfig;
  readonly protocol: string;
  readonly path: string;
  readonly body: JsonObject;
  readonly headers: Readonly<Record<string, string>>;
  readonly control: LlmControl;
  readonly limits: LlmLimits;
  readonly decoder: ProtocolDecoder;
  readonly onEvent: (event: ProviderEvent) => Promise<LlmResult<void>>;
}
export interface ProtocolInput {
  readonly request: LlmRequest;
  readonly provider: string;
  readonly model: ModelDescription;
  readonly limits: LlmLimits;
}
