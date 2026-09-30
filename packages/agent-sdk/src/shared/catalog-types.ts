export type ProviderProtocol = "anthropic" | "openai";

export interface HubModelMeta {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: Record<string, number>;
}

export interface HubProviderProfile {
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly models: readonly (string | HubModelMeta)[];
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

export interface HubProvidersFile {
  readonly providers: readonly HubProviderProfile[];
  readonly default?: { readonly provider: string; readonly model: string; readonly thinking?: string };
  readonly modelOverrides?: Record<string, { readonly contextWindow?: number; readonly maxOutputTokens?: number }>;
}

export interface CatalogEntry {
  readonly provider: string;
  readonly model: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly reasoning: boolean;
  readonly input?: ("text" | "image")[];
  readonly cost?: Record<string, number>;
  readonly source: "preset" | "custom";
}

export interface AssemblyProvider {
  readonly provider: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: readonly string[];
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly maxOutputTokensByModel?: Readonly<Record<string, number>>;
}
