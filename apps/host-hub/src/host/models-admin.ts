// 目录管理（DESIGN §3.6）：models/add（校验：id/provider/protocol/baseUrl 必填、
// api ∈ {anthropic, openai}、数值正整数；provider 已存在并入 models，否则必带
// protocol+baseUrl 新建档案）与 models/remove（仅 custom 条目；预设裸名 →
// unknown model preset；删被预设覆盖的 custom 条目 = 恢复预设视图）。窄合并经
// updateProvidersFile 串行链 + 原子写。
import { readCatalog, providersFilePath } from "../shared/catalog.ts";
import type { HubModelMeta, HubProvidersFile } from "../shared/catalog-types.ts";
import { atomicWriteJson, readJson, updateJson } from "../shared/atomic-file.ts";
import { modelShapeOf } from "./models-auth.ts";

type ProvidersFile = HubProvidersFile & { modelOverrides?: Record<string, { contextWindow?: number; maxOutputTokens?: number }> };

function seedApiKeyEnv(existing: { apiKeyEnv?: string } | undefined, input: { apiKeyEnv?: unknown }): string | undefined {
  if (existing?.apiKeyEnv !== undefined) return existing.apiKeyEnv;
  if (typeof input.apiKeyEnv === "string" && input.apiKeyEnv !== "") return input.apiKeyEnv;
  return undefined;
}

async function readProvidersFile(agentDir: string): Promise<ProvidersFile> {
  const parsed = await readJson<ProvidersFile>(providersFilePath(agentDir), { providers: [] });
  return parsed !== undefined && Array.isArray((parsed as { providers?: unknown }).providers)
    ? (parsed as ProvidersFile)
    : { providers: [] };
}

/** providers.json 串行读改写（分链/回收/原子写全在 atomic-file 单点） */
export function updateProvidersFile(agentDir: string, mutate: (file: ProvidersFile) => ProvidersFile | Promise<ProvidersFile>): Promise<ProvidersFile> {
  const path = providersFilePath(agentDir);
  return updateJson<ProvidersFile>(path, {
    read: () => readProvidersFile(agentDir),
    write: (next) => atomicWriteJson(path, next),
    mutate,
  });
}

function positiveInt(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** add 的模型对象回显（刷新后完整形状——附录 B；构造单点 = modelShapeOf） */
async function refreshedModelShape(agentDir: string, provider: string, id: string): Promise<Record<string, unknown> | undefined> {
  const catalog = await readCatalog(agentDir);
  const entry = catalog.entries.find((e) => e.provider === provider && e.model === id);
  return modelShapeOf(entry);
}

/** 数值/布尔字段校验（单点错误面）；input 成员拒绝式校验——写门不放拼写错误进盘（读侧净化只兜手改文件） */
function validateFields(input: { [key: string]: unknown }): string | undefined {
  const { contextWindow, maxTokens, reasoning, cost, input: inputModes } = input;
  if (contextWindow !== undefined && !positiveInt(contextWindow)) return `invalid model entry: contextWindow must be a positive integer (got ${String(contextWindow)})`;
  if (maxTokens !== undefined && !positiveInt(maxTokens)) return `invalid model entry: maxTokens must be a positive integer (got ${String(maxTokens)})`;
  if (reasoning !== undefined && typeof reasoning !== "boolean") return `invalid model entry: reasoning must be a boolean (got ${String(reasoning)})`;
  if (cost !== undefined && (typeof cost !== "object" || cost === null || Array.isArray(cost))) return "invalid model entry: cost must be an object";
  if (inputModes !== undefined && (!Array.isArray(inputModes) || inputModes.some((member) => member !== "text" && member !== "image"))) {
    return `invalid model entry: input must be an array of text|image (got ${JSON.stringify(inputModes)})`;
  }
  return undefined;
}

/** 新档案校验（provider 缺席时必带 protocol+baseUrl） */
function validateNewProfile(providerName: string, protocol: unknown, baseUrl: string): string | undefined {
  if (providerName.trim() === "") return "invalid model entry: provider required for a new profile";
  if (protocol !== "anthropic" && protocol !== "openai") return "invalid model entry: protocol must be one of anthropic, openai";
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) return "invalid model entry: baseUrl must be an http(s) URL";
  return undefined;
}

function metaOf(id: string, input: { [key: string]: unknown }): HubModelMeta {
  const { contextWindow, maxTokens, reasoning, cost, input: inputModes } = input;
  return {
    id,
    ...(positiveInt(contextWindow) ? { contextWindow: contextWindow as number } : {}),
    ...(positiveInt(maxTokens) ? { maxTokens: maxTokens as number } : {}),
    ...(typeof reasoning === "boolean" ? { reasoning } : {}),
    ...(Array.isArray(inputModes) && inputModes.length > 0 ? { input: inputModes as ("text" | "image")[] } : {}),
    ...(cost !== undefined ? { cost: cost as Record<string, number> } : {}),
  };
}

export async function addModel(agentDir: string, input: { [key: string]: unknown }): Promise<{ ok: true; model: Record<string, unknown> | undefined } | { ok: false; error: string }> {
  const id = typeof input.id === "string" ? input.id : "";
  if (id.trim() === "") return { ok: false, error: "invalid model entry: id required" };
  const providerName = typeof input.provider === "string" ? input.provider : "";
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl : "";
  const fieldError = validateFields(input);
  if (fieldError !== undefined) return { ok: false, error: fieldError };

  const catalog = await readCatalog(agentDir);
  const existing = catalog.profiles.find((profile) => profile.name === providerName);
  if (existing === undefined) {
    const profileError = validateNewProfile(providerName, input.protocol, baseUrl);
    if (profileError !== undefined) return { ok: false, error: profileError };
  } else if (catalog.entries.some((entry) => entry.provider === providerName && entry.model === id && entry.source === "preset")) {
    return { ok: false, error: `invalid model entry: model id already covered by a preset (${id})` };
  }

  const meta = metaOf(id, input);
  const bareEntry = Object.keys(meta).length === 1; // 仅 id——落裸串形态
  await updateProvidersFile(agentDir, (file) => {
    const providers = [...file.providers];
    const index = providers.findIndex((profile) => profile.name === providerName);
    if (index === -1) {
      // 预设名首写：档案从预设继承协议/端点（providers.json 未落该档案——缺省会降级
      // 坏档案）；全新档案则用入参 protocol/baseUrl
      const seed = existing ?? { protocol: input.protocol as "anthropic" | "openai", baseUrl };
      providers.push({
        name: providerName,
        protocol: seed.protocol,
        baseUrl: seed.baseUrl,
        ...(seedApiKeyEnv(existing, input) !== undefined ? { apiKeyEnv: seedApiKeyEnv(existing, input) } : {}),
        ...(existing?.contextWindow !== undefined ? { contextWindow: existing.contextWindow } : {}),
        ...(existing?.maxOutputTokens !== undefined ? { maxOutputTokens: existing.maxOutputTokens } : {}),
        models: [bareEntry ? id : meta],
      });
      return { ...file, providers };
    }
    const profile = providers[index];
    if (profile === undefined) return { ...file, providers };
    const models: (string | HubModelMeta)[] = profile.models.filter((model) => (typeof model === "string" ? model !== id : (model as { id?: unknown }).id !== id));
    models.push(bareEntry ? id : meta);
    providers[index] = { ...profile, models };
    return { ...file, providers };
  });
  return { ok: true, model: await refreshedModelShape(agentDir, providerName, id) };
}

export async function removeModel(agentDir: string, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const catalog = await readCatalog(agentDir);
  const custom = catalog.entries.find((entry) => entry.model === id && entry.source === "custom");
  if (custom === undefined) {
    return { ok: false, error: `unknown model preset: ${id} (available: ${catalog.entries.map((entry) => entry.model).join(", ")})` };
  }
  await updateProvidersFile(agentDir, (file) => {
    const providers = file.providers.map((profile) => {
      const models = profile.models.filter((model) => (typeof model === "string" ? model !== id : (model as { id?: unknown }).id !== id));
      return { ...profile, models };
    }).filter((profile) => profile.models.length > 0);
    return { ...file, providers };
  });
  return { ok: true };
}
