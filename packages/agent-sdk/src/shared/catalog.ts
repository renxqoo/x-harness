import { join } from "node:path";
import { PRESET_DEFAULT, PRESET_PROFILES } from "./presets.ts";
import type { AssemblyProvider, CatalogEntry, HubModelMeta, HubProviderProfile, HubProvidersFile } from "./catalog-types.ts";

export interface ModelsCatalog {
  profiles: readonly HubProviderProfile[];
  entries: readonly CatalogEntry[];
  defaults: { provider: string; model: string };
  degraded: boolean;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validModels(models: unknown): models is HubProviderProfile["models"] {
  if (!Array.isArray(models) || models.length === 0) return false;
  return models.every((model) => {
    if (typeof model === "string") return model.trim() !== "";
    return isObj(model) && typeof model.id === "string" && model.id.trim() !== "";
  });
}

function validProfile(raw: unknown): raw is HubProviderProfile {
  if (!isObj(raw)) return false;
  if (typeof raw.name !== "string" || raw.name.trim() === "") return false;
  if (raw.protocol !== "anthropic" && raw.protocol !== "openai") return false;
  if (typeof raw.baseUrl !== "string" || !(raw.baseUrl.startsWith("http://") || raw.baseUrl.startsWith("https://"))) return false;
  return validModels(raw.models);
}

function modelId(model: string | HubModelMeta): string {
  return typeof model === "string" ? model : model.id;
}

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  return values.find((value) => value !== undefined);
}

function entryOf(profile: HubProviderProfile, model: string | HubModelMeta, source: "preset" | "custom"): CatalogEntry {
  const meta: Partial<HubModelMeta> = typeof model === "string" ? {} : model;
  const contextWindow = firstDefined(meta.contextWindow, profile.contextWindow);
  const maxTokens = firstDefined(meta.maxTokens, profile.maxOutputTokens);
  const input = Array.isArray(meta.input)
    ? meta.input.filter((member): member is "text" | "image" => member === "text" || member === "image")
    : undefined;
  return {
    provider: profile.name,
    model: modelId(model),
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    ...(profile.apiKeyEnv !== undefined ? { apiKeyEnv: profile.apiKeyEnv } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    reasoning: meta.reasoning ?? true,
    ...(input !== undefined && input.length > 0 ? { input } : {}),
    ...(meta.cost !== undefined ? { cost: meta.cost } : {}),
    source,
  };
}

function customProfilesOf(file: HubProvidersFile | undefined): { profiles: HubProviderProfile[]; degraded: boolean } {
  if (file === undefined) return { profiles: [], degraded: false };
  if (!Array.isArray(file.providers)) return { profiles: [], degraded: true };
  const profiles: HubProviderProfile[] = [];
  let degraded = false;
  for (const raw of file.providers) {
    if (validProfile(raw)) profiles.push(raw);
    else degraded = true;
  }
  return { profiles, degraded };
}

function defaultsOf(file: HubProvidersFile | undefined): { provider: string; model: string } {
  const fallback = { provider: PRESET_DEFAULT.provider, model: PRESET_DEFAULT.model };
  const def = file?.default;
  if (def === undefined || typeof def.provider !== "string" || typeof def.model !== "string") return fallback;
  return { provider: def.provider, model: def.model };
}

async function readProvidersFile(agentDir: string): Promise<{ file: HubProvidersFile | undefined; degraded: boolean }> {
  let raw: string;
  try {
    raw = await Bun.file(join(agentDir, "providers.json")).text();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { file: undefined, degraded: code !== "ENOENT" };
  }
  try {
    return { file: JSON.parse(raw) as HubProvidersFile, degraded: false };
  } catch {
    return { file: undefined, degraded: true };
  }
}

export async function readCatalog(agentDir: string): Promise<ModelsCatalog> {
  const read = await readProvidersFile(agentDir);
  const file = read.file;
  const custom = customProfilesOf(file);
  const customNames = new Set(custom.profiles.map((p) => p.name));
  const byName = new Map<string, HubProviderProfile>();
  for (const profile of custom.profiles) byName.set(profile.name, profile);
  for (const preset of PRESET_PROFILES) {
    if (!byName.has(preset.name)) byName.set(preset.name, preset);
  }
  const overrides = file?.modelOverrides ?? {};
  const entries: CatalogEntry[] = [];
  for (const profile of byName.values()) {
    const source = customNames.has(profile.name) ? ("custom" as const) : ("preset" as const);
    for (const model of profile.models) {
      const id = modelId(model);
      entries.push(applyOverride(entryOf(profile, model, source), { provider: profile.name, model: id }, overrides));
    }
  }
  return { profiles: [...byName.values()], entries, defaults: defaultsOf(file), degraded: read.degraded || custom.degraded };
}

function applyOverride(entry: CatalogEntry, spec: { provider: string; model: string }, overrides: Record<string, { readonly contextWindow?: number; readonly maxOutputTokens?: number }>): CatalogEntry {
  const o = overrides[`${spec.provider}::${spec.model}`] ?? overrides[spec.model];
  if (o === undefined) return entry;
  return {
    ...entry,
    ...(isPositiveInt(o.contextWindow) ? { contextWindow: o.contextWindow } : {}),
    ...(isPositiveInt(o.maxOutputTokens) ? { maxTokens: o.maxOutputTokens } : {}),
  };
}

export function resolveDefaultDial(catalog: ModelsCatalog): { provider: string; model: string } | undefined {
  const exact = catalog.entries.find((e) => e.provider === catalog.defaults.provider && e.model === catalog.defaults.model);
  if (exact !== undefined) return { provider: exact.provider, model: exact.model };
  const first = catalog.entries[0];
  return first !== undefined ? { provider: first.provider, model: first.model } : undefined;
}

function maxOutputTokensByModelOf(catalog: ModelsCatalog, profile: HubProviderProfile): Readonly<Record<string, number>> | undefined {
  const ids = new Set(profile.models.map(modelId));
  const byModel: Record<string, number> = {};
  for (const entry of catalog.entries) {
    if (entry.provider === profile.name && ids.has(entry.model) && entry.maxTokens !== undefined) byModel[entry.model] = entry.maxTokens;
  }
  return Object.keys(byModel).length > 0 ? byModel : undefined;
}

export function buildAssemblySnapshot(
  catalog: ModelsCatalog,
  credentials: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>>,
): AssemblyProvider[] {
  return catalog.profiles.map((profile) => {
    const apiKeyEnv = profile.apiKeyEnv;
    const apiKey = firstDefined(credentials[profile.name], profile.apiKey, apiKeyEnv !== undefined ? env[apiKeyEnv] : undefined) ?? "";
    const maxOutputTokensByModel = maxOutputTokensByModelOf(catalog, profile);
    return {
      provider: profile.name,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      apiKey,
      models: profile.models.map(modelId),
      ...(profile.contextWindow !== undefined ? { contextWindow: profile.contextWindow } : {}),
      ...(profile.maxOutputTokens !== undefined ? { maxOutputTokens: profile.maxOutputTokens } : {}),
      ...(maxOutputTokensByModel !== undefined ? { maxOutputTokensByModel } : {}),
    };
  });
}

export async function ensureAgentDir(agentDir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await mkdir(join(agentDir, "bash-outputs"), { recursive: true });
}

export function providersFilePath(agentDir: string): string {
  return join(agentDir, "providers.json");
}
