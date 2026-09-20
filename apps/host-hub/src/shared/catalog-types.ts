// 目录类型（DESIGN §3.6）：providers.json 超集（apps/cli ProvidersConfig 兼容 + hub
// 增量字段 apiKeyEnv/模型元数据对象/modelOverrides 节）。类型单源——catalog.ts 的
// 读写/校验/快照构造与本文件成对。
export type ProviderProtocol = "anthropic" | "openai";

/** 模型条目：裸 id 或带元数据对象（contextWindow/maxTokens/reasoning/cost） */
export interface HubModelMeta {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  cost?: Record<string, number>;
}

export interface HubProviderProfile {
  /** provider 标识（wire 面 provider 字段 = adapter 注册名） */
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  /** 字面 key（CLI providers.json 兼容面；credentials.json 优先级更高） */
  readonly apiKey?: string;
  /** env 键名（缺省 HUB_API_KEY；preset 档案自带） */
  readonly apiKeyEnv?: string;
  readonly models: readonly (string | HubModelMeta)[];
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

export interface HubProvidersFile {
  readonly providers: readonly HubProviderProfile[];
  readonly default?: { readonly provider: string; readonly model: string; readonly thinking?: string };
  /** 逐模型覆写（`<provider>::<model>` 与 `<model>` 双键宽松命中） */
  readonly modelOverrides?: Record<string, { readonly contextWindow?: number; readonly maxOutputTokens?: number }>;
}

/** get_models 条目（永不携带 apiKey） */
export interface CatalogEntry {
  readonly provider: string;
  readonly model: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly reasoning: boolean;
  readonly cost?: Record<string, number>;
  readonly source: "preset" | "custom";
}

/** worker 装配快照单元（HUB_WORKER_PROVIDERS 载荷——apiKey 已解析） */
export interface AssemblyProvider {
  readonly provider: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: readonly string[];
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}
