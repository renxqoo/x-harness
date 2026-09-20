// 内置渠道预设（DESIGN §3.6）：产品开箱可拨号的档案（GLM 家族）；custom 档案同名
// 整档覆盖预设（providers.json 单一事实，预设只兜底）。协议知识（端点/鉴权 env/
// 窗口/成本表）唯一专家是本文件，不泄漏宿主。
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
        cost: { input: 8, output: 16, cacheRead: 1, cacheWrite: 0 },
      },
    ],
    contextWindow: 1_000_000,
    maxOutputTokens: 34_000,
  },
];

/** 预设缺省拨号（无 providers.json/default 时的 thread/start 模型） */
export const PRESET_DEFAULT = { provider: "glm", model: "glm-5.3" } as const;
