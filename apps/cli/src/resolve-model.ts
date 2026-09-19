// 两层模型解析（docs/CLI.md §2.6）：defaults 供新建会话；overrides 只含用户显式 flag，
// 供 resume——AgentOptions 显式值在 agent-loop 折叠时恒胜会话末次记录，resume 传全量
// defaults 会静默改写历史会话的模型/thinking，因此两层必须分开。

import type { Result } from "@x-harness/core";
import type { ProvidersConfig, ProviderProfile, ThinkingLevelCli } from "./providers-file.ts";

export interface ModelChoice {
  readonly provider: string;
  readonly model: string;
  readonly thinking?: ThinkingLevelCli;
  readonly apiKey?: string;
}

export interface ModelResolution {
  /** 新建会话用：default + 显式 flag 合成的完整选择 */
  readonly defaults: ModelChoice;
  /** resume 用：仅用户显式给出的 flag（未给的留 undefined 回落会话末次 dial） */
  readonly overrides: Partial<ModelChoice>;
  /** --api-key 绑定的 provider 名（= overrides.provider ?? defaults.provider；装配期折进该档案 adapter） */
  readonly apiKeyProvider: string;
}

export interface ModelFlags {
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: ThinkingLevelCli;
  readonly apiKey?: string;
}

function byName(config: ProvidersConfig, name: string): ProviderProfile | undefined {
  return config.providers.find((p) => p.name === name);
}

/** --model 归属：--provider 在场必须落在该档案；缺席时全档案唯一命中，多/零命中报错 */
function resolveModelOwner(config: ProvidersConfig, flags: ModelFlags): Result<{ provider: string; model: string }> {
  if (flags.provider !== undefined) {
    const profile = byName(config, flags.provider);
    if (profile === undefined) {
      return { ok: false, reason: `--provider: unknown provider "${flags.provider}" (declared: ${config.providers.map((p) => p.name).join(", ")})` };
    }
    if (flags.model !== undefined && !profile.models.includes(flags.model)) {
      return { ok: false, reason: `--model: "${flags.model}" is not in provider "${profile.name}" models (${profile.models.join(", ")})` };
    }
    const model = flags.model ?? config.default.model;
    if (!profile.models.includes(model)) {
      return { ok: false, reason: `--model: default model "${model}" is not in provider "${profile.name}" models (${profile.models.join(", ")})` };
    }
    return { ok: true, value: { provider: profile.name, model } };
  }
  if (flags.model === undefined) return { ok: true, value: { provider: config.default.provider, model: config.default.model } };
  const owners = config.providers.filter((p) => p.models.includes(flags.model ?? ""));
  if (owners.length === 0) {
    return { ok: false, reason: `--model: "${flags.model}" not found in any provider (use --provider or check providers.json)` };
  }
  if (owners.length > 1) {
    return { ok: false, reason: `--model: "${flags.model}" is ambiguous across providers ${owners.map((p) => p.name).join(", ")} — pass --provider` };
  }
  const owner = owners[0];
  if (owner === undefined) return { ok: false, reason: `--model: "${flags.model}" not resolvable` };
  return { ok: true, value: { provider: owner.name, model: flags.model } };
}

/** off 与缺席语义等价（不发 thinking 参数），统一归一为 undefined */
function normalizeThinking(level: ThinkingLevelCli | undefined): ThinkingLevelCli | undefined {
  return level === "off" ? undefined : level;
}

export function resolveModel(config: ProvidersConfig, flags: ModelFlags): Result<ModelResolution> {
  const owner = resolveModelOwner(config, flags);
  if (!owner.ok) return owner;
  const defaultsThinking = flags.thinking !== undefined ? normalizeThinking(flags.thinking) : normalizeThinking(config.default.thinking);
  // overrides 的 provider/model 成对：resume 只带 model 会把请求发到会话末次 provider 的
  // 适配器（模型错投）；--model 唯一命中已解析出归属档案，成对下传
  const dialOverride = flags.model !== undefined || flags.provider !== undefined
    ? { provider: owner.value.provider, model: owner.value.model }
    : {};
  return {
    ok: true,
    value: {
      defaults: {
        provider: owner.value.provider,
        model: owner.value.model,
        ...(defaultsThinking !== undefined ? { thinking: defaultsThinking } : {}),
        ...(flags.apiKey !== undefined ? { apiKey: flags.apiKey } : {}),
      },
      overrides: {
        ...dialOverride,
        ...(normalizeThinking(flags.thinking) !== undefined ? { thinking: normalizeThinking(flags.thinking) } : {}),
        ...(flags.apiKey !== undefined ? { apiKey: flags.apiKey } : {}),
      },
      apiKeyProvider: owner.value.provider,
    },
  };
}
