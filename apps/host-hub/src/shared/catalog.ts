// 模型目录（DESIGN §3.6）：预设 + <agentDir>/providers.json（HubProvidersFile 超集）
// + modelOverrides 节。host（get_models/热刷新/auth 面）与 worker（装配快照）共用
// 单份——坏 JSON 降级仅预设（hub_error 由调用方发）；custom 档案同名整档覆盖预设。
import { join } from "node:path";
import { PRESET_DEFAULT, PRESET_PROFILES } from "./presets.ts";
import type { AssemblyProvider, CatalogEntry, HubModelMeta, HubProviderProfile, HubProvidersFile } from "./catalog-types.ts";

export interface ModelsCatalog {
  /** 合并后的档案（custom 覆盖同名 preset；entries 的展开源） */
  profiles: readonly HubProviderProfile[];
  entries: readonly CatalogEntry[];
  /** 缺省拨号（file.default > 预设缺省） */
  defaults: { provider: string; model: string };
  /** 文件不可解析/含非法档案（降级标记——调用方发 hub_error） */
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

/** 档案级校验（垃圾档案跳过 + degraded——不静默混入坏端点） */
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

/** 档案展开条目（模型级 meta > 档案级缺省；overrides 应用在 readCatalog 尾部） */
function entryOf(profile: HubProviderProfile, model: string | HubModelMeta, source: "preset" | "custom"): CatalogEntry {
  const meta: Partial<HubModelMeta> = typeof model === "string" ? {} : model;
  const contextWindow = firstDefined(meta.contextWindow, profile.contextWindow);
  const maxTokens = firstDefined(meta.maxTokens, profile.maxOutputTokens);
  return {
    provider: profile.name,
    model: modelId(model),
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    ...(profile.apiKeyEnv !== undefined ? { apiKeyEnv: profile.apiKeyEnv } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    reasoning: meta.reasoning ?? true,
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
    // ENOENT = 首跑常态；其余（不可读）= 降级告警
    return { file: undefined, degraded: code !== "ENOENT" };
  }
  try {
    return { file: JSON.parse(raw) as HubProvidersFile, degraded: false };
  } catch {
    return { file: undefined, degraded: true }; // 坏 JSON 降级仅预设（调用方发 hub_error）
  }
}

export async function readCatalog(agentDir: string): Promise<ModelsCatalog> {
  const read = await readProvidersFile(agentDir);
  const file = read.file;
  const custom = customProfilesOf(file);
  const customNames = new Set(custom.profiles.map((p) => p.name));
  // custom 同名整档覆盖预设（单一事实 = providers.json；预设只兜底缺席档案）
  const byName = new Map<string, HubProviderProfile>();
  for (const preset of PRESET_PROFILES) byName.set(preset.name, preset);
  for (const profile of custom.profiles) byName.set(profile.name, profile);
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

/** overrides 应用：`<provider>::<model>` 与 `<model>` 双键查（宽松匹配，命中即覆写） */
function applyOverride(entry: CatalogEntry, spec: { provider: string; model: string }, overrides: Record<string, { readonly contextWindow?: number; readonly maxOutputTokens?: number }>): CatalogEntry {
  const o = overrides[`${spec.provider}::${spec.model}`] ?? overrides[spec.model];
  if (o === undefined) return entry;
  return {
    ...entry,
    ...(isPositiveInt(o.contextWindow) ? { contextWindow: o.contextWindow } : {}),
    ...(isPositiveInt(o.maxOutputTokens) ? { maxTokens: o.maxOutputTokens } : {}),
  };
}

/** 目录缺省拨号解析（entries 内查——defaults 可能被覆写挤出目录，此时回落首条） */
export function resolveDefaultDial(catalog: ModelsCatalog): { provider: string; model: string } | undefined {
  const exact = catalog.entries.find((e) => e.provider === catalog.defaults.provider && e.model === catalog.defaults.model);
  if (exact !== undefined) return { provider: exact.provider, model: exact.model };
  const first = catalog.entries[0];
  return first !== undefined ? { provider: first.provider, model: first.model } : undefined;
}

/** worker 装配快照构造（DESIGN §3.6）：apiKey 解析序 = credentials > 档案字面 >
 *  apiKeyEnv 环境变量；快照经 HUB_WORKER_PROVIDERS 单通道注入（worker 不读文件） */
export function buildAssemblySnapshot(
  catalog: ModelsCatalog,
  credentials: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>>,
): AssemblyProvider[] {
  return catalog.profiles.map((profile) => {
    const apiKeyEnv = profile.apiKeyEnv; // 无声明不回退全局 env 键（凭据外送面关闭）
    const apiKey = firstDefined(credentials[profile.name], profile.apiKey, apiKeyEnv !== undefined ? env[apiKeyEnv] : undefined) ?? "";
    return {
      provider: profile.name,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      apiKey,
      models: profile.models.map(modelId),
      ...(profile.contextWindow !== undefined ? { contextWindow: profile.contextWindow } : {}),
      ...(profile.maxOutputTokens !== undefined ? { maxOutputTokens: profile.maxOutputTokens } : {}),
    };
  });
}

/** 首跑保障：目录结构自动创建（零配置可启动） */
export async function ensureAgentDir(agentDir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await mkdir(join(agentDir, "bash-outputs"), { recursive: true });
}

/** providers.json 路径（models-admin / tmp-sweep 单源） */
export function providersFilePath(agentDir: string): string {
  return join(agentDir, "providers.json");
}
