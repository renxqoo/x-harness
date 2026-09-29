import type { HubProviderProfile } from "./catalog-types.ts";

export const PRESET_PROFILES: readonly HubProviderProfile[] = [
  {
    name: "glm",
    protocol: "anthropic",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    apiKeyEnv: "GLM_API_KEY",
    models: [
      {
        id: "glm-5.3",
        contextWindow: 1_000_000,
        maxTokens: 34_000,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 8, output: 16, cacheRead: 1, cacheWrite: 0 },
      },
    ],
    contextWindow: 1_000_000,
    maxOutputTokens: 34_000,
  },
];

export const PRESET_DEFAULT = { provider: "glm", model: "glm-5.3" } as const;
