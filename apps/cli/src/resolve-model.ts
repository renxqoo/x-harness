import type { Result } from "@x-harness/core";
import type { ProvidersConfig, ProviderProfile, ThinkingLevelCli } from "./providers-file.ts";

export interface ModelChoice {
  readonly provider: string;
  readonly model: string;
  readonly thinking?: ThinkingLevelCli;
  readonly apiKey?: string;
}

export interface ModelResolution {
  readonly defaults: ModelChoice;
  readonly overrides: Partial<ModelChoice>;
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

function normalizeThinking(level: ThinkingLevelCli | undefined): ThinkingLevelCli | undefined {
  return level === "off" ? undefined : level;
}

export function resolveModel(config: ProvidersConfig, flags: ModelFlags): Result<ModelResolution> {
  const owner = resolveModelOwner(config, flags);
  if (!owner.ok) return owner;
  const defaultsThinking = flags.thinking !== undefined ? normalizeThinking(flags.thinking) : normalizeThinking(config.default.thinking);
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
        ...(flags.thinking !== undefined ? { thinking: flags.thinking } : {}),
        ...(flags.apiKey !== undefined ? { apiKey: flags.apiKey } : {}),

      },
      apiKeyProvider: owner.value.provider,
    },
  };
}
