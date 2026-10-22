import type { JsonValue } from "../../../../core/src/index";
export type JsonObject = Readonly<Record<string, JsonValue>>;
export interface ProviderContinuation {
  readonly provider: string;
  readonly protocol: string;
  readonly model: string;
  readonly data: JsonValue;
}
export interface TextContent {
  readonly type: "text";
  readonly text: string;
}
export interface ImageContent {
  readonly type: "image";
  readonly source:
    | { readonly type: "url"; readonly url: string }
    | { readonly type: "base64"; readonly mediaType: string; readonly data: string };
}
export interface DocumentContent {
  readonly type: "document";
  readonly sourceId: string;
  readonly title?: string;
  readonly citations?: boolean;
  readonly source:
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "base64"; readonly mediaType: "application/pdf"; readonly data: string }
    | { readonly type: "url"; readonly url: string }
    | { readonly type: "file-id"; readonly id: string };
}
export interface SearchResultContent {
  readonly type: "search-result";
  readonly sourceId: string;
  readonly title: string;
  readonly source: string;
  readonly content: readonly TextContent[];
  readonly citations?: boolean;
}
export type UserContent = TextContent | ImageContent | DocumentContent | SearchResultContent;
export type AssistantContent =
  | TextContent
  | { readonly type: "refusal"; readonly text: string }
  | {
      readonly type: "reasoning";
      readonly text?: string;
      readonly continuation?: ProviderContinuation;
    }
  | {
      readonly type: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly input: JsonObject;
    }
  | { readonly type: "provider"; readonly continuation: ProviderContinuation };
export type LlmMessage =
  | { readonly role: "system" | "developer"; readonly content: readonly TextContent[] }
  | { readonly role: "user"; readonly content: readonly UserContent[] }
  | { readonly role: "assistant"; readonly content: readonly AssistantContent[] }
  | {
      readonly role: "tool";
      readonly callId: string;
      readonly isError?: boolean;
      readonly content: readonly UserContent[];
    };
