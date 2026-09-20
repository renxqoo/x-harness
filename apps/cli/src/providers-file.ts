// providers.json 契约（docs/CLI.md §2.2）：多 provider 档案的定位/校验/读取。
// 解析是纯函数（垃圾输入返回失败理由不抛）；IO 只一层读文件。校验失败错误用中性英文，
// 退出码归属 main（exit 2）。

import type { Result } from "@x-harness/core";
import { readFile } from "node:fs/promises";

export type ProviderProtocol = "anthropic" | "openai";
export type ThinkingLevelCli = "off" | "low" | "medium" | "high" | "max";

const PROTOCOLS: readonly ProviderProtocol[] = ["anthropic", "openai"];

export interface ProviderProfile {
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: readonly string[];
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

export interface DefaultChoice {
  readonly provider: string;
  readonly model: string;
  readonly thinking: ThinkingLevelCli;
}

export interface ProvidersConfig {
  readonly providers: readonly ProviderProfile[];
  readonly default: DefaultChoice;
}

/** 词表导出：--thinking/default.thinking 共用同一闭集（单一真相） */
export const THINKING_LEVELS: readonly ThinkingLevelCli[] = ["off", "low", "medium", "high", "max"];

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyStr(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

interface FieldError { readonly ok: false; readonly reason: string }

/** 封闭模式校验：未知键显式报错（allowed 集随错误给出）——拼错/字段改名不留静默吞没通道 */
function rejectUnknownFields(obj: Record<string, unknown>, allowed: readonly string[], label: string): FieldError | undefined {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      return { ok: false, reason: `${label}: unknown field "${key}" (allowed: ${allowed.join(", ")})` };
    }
  }
  return undefined;
}

function requireString(obj: Record<string, unknown>, field: string, label: string): Result<string> | FieldError {
  const value = obj[field];
  if (!isNonEmptyStr(value)) return { ok: false, reason: `${label}.${field}: expected a non-empty string` };
  return { ok: true, value };
}

function parseProtocol(obj: Record<string, unknown>, label: string): Result<ProviderProtocol> {
  const protocol = obj.protocol;
  if (protocol !== "anthropic" && protocol !== "openai") {
    return { ok: false, reason: `${label}.protocol: expected one of ${PROTOCOLS.join(" | ")}` };
  }
  return { ok: true, value: protocol };
}

function parseBaseUrl(obj: Record<string, unknown>, label: string): Result<string> {
  const value = obj.baseUrl;
  if (!isNonEmptyStr(value) || !isHttpUrl(value)) {
    return { ok: false, reason: `${label}.baseUrl: expected an http(s) URL` };
  }
  return { ok: true, value };
}

function parseModels(obj: Record<string, unknown>, label: string): Result<readonly string[]> {
  const models = obj.models;
  if (!Array.isArray(models) || models.length === 0 || !models.every(isNonEmptyStr)) {
    return { ok: false, reason: `${label}.models: expected a non-empty array of non-empty strings` };
  }
  if (new Set(models).size !== models.length) {
    return { ok: false, reason: `${label}.models: duplicate entries` };
  }
  return { ok: true, value: models as readonly string[] };
}

const PROFILE_FIELDS: readonly string[] = ["name", "protocol", "baseUrl", "apiKey", "models", "contextWindow", "maxOutputTokens"];

/** 可选数值字段：contextWindow/maxOutputTokens 两协议通用（正整数） */
function parseOptionalNumbers(obj: Record<string, unknown>, label: string): Result<Pick<ProviderProfile, "contextWindow" | "maxOutputTokens">> {
  const contextWindow = obj.contextWindow;
  if (contextWindow !== undefined && !isPositiveInt(contextWindow)) {
    return { ok: false, reason: `${label}.contextWindow: expected a positive integer` };
  }
  const maxOutputTokens = obj.maxOutputTokens;
  if (maxOutputTokens === undefined) {
    return { ok: true, value: contextWindow !== undefined ? { contextWindow } : {} };
  }

  if (!isPositiveInt(maxOutputTokens)) {
    return { ok: false, reason: `${label}.maxOutputTokens: expected a positive integer` };
  }
  return {
    ok: true,
    value: { ...(contextWindow !== undefined ? { contextWindow } : {}), maxOutputTokens },
  };
}

/** 单档案校验：字段名/闭集/唯一性全部在本层闭口（错误带字段路径便于定位） */
function parseProfile(raw: unknown, index: number): Result<ProviderProfile> {
  if (!isObj(raw)) return { ok: false, reason: `providers[${index}]: expected an object` };
  const unknown = rejectUnknownFields(raw, PROFILE_FIELDS, `providers[${index}]`);
  if (unknown !== undefined) return unknown;
  const name = requireString(raw, "name", `providers[${index}]`);
  if (!name.ok) return name;
  const label = `providers[${index}] (${name.value})`;
  const protocol = parseProtocol(raw, label);
  if (!protocol.ok) return protocol;
  const baseUrl = parseBaseUrl(raw, label);
  if (!baseUrl.ok) return baseUrl;
  const apiKey = requireString(raw, "apiKey", label);
  if (!apiKey.ok) return apiKey;
  const models = parseModels(raw, label);
  if (!models.ok) return models;
  const numbers = parseOptionalNumbers(raw, label);
  if (!numbers.ok) return numbers;
  return {
    ok: true,
    value: {
      name: name.value,
      protocol: protocol.value,
      baseUrl: baseUrl.value,
      apiKey: apiKey.value,
      models: models.value,
      ...numbers.value,
    },
  };
}

/** default 缺省合成：单档案无 default → 首个 model + thinking off；多档案无 default → 报错 */
function synthesizeDefault(rawDefault: unknown, providers: readonly ProviderProfile[]): Result<DefaultChoice> {
  if (rawDefault === undefined) {
    const only = providers[0];
    if (providers.length === 1 && only !== undefined) {
      const model = only.models[0];
      if (model !== undefined) return { ok: true, value: { provider: only.name, model, thinking: "off" } };
    }
    return { ok: false, reason: "default: required when more than one provider is declared" };
  }
  if (!isObj(rawDefault)) return { ok: false, reason: "default: expected an object" };
  const unknown = rejectUnknownFields(rawDefault, ["provider", "model", "thinking"], "default");
  if (unknown !== undefined) return unknown;
  const providerName = rawDefault.provider;
  if (!isNonEmptyStr(providerName)) return { ok: false, reason: "default.provider: expected a non-empty string" };
  const provider = providers.find((p) => p.name === providerName);
  if (provider === undefined) {
    return { ok: false, reason: `default.provider: unknown provider "${providerName}" (declared: ${providers.map((p) => p.name).join(", ")})` };
  }
  const model = rawDefault.model;
  if (!isNonEmptyStr(model) || !provider.models.includes(model)) {
    return { ok: false, reason: `default.model: "${String(model)}" is not in provider "${providerName}" models (${provider.models.join(", ")})` };
  }
  const rawThinking = rawDefault.thinking;
  const match = THINKING_LEVELS.find((level) => level === rawThinking);
  if (rawThinking !== undefined && match === undefined) {
    return { ok: false, reason: `default.thinking: expected one of ${THINKING_LEVELS.join(" | ")}` };
  }
  const thinking = match ?? "off";
  return { ok: true, value: { provider: providerName, model, thinking } };
}

/** 纯解析：unknown → ProvidersConfig；全部校验失败以 reason 返回（docs/CLI.md §2.2 逐条） */
export function parseProvidersConfig(raw: unknown): Result<ProvidersConfig> {
  if (!isObj(raw)) return { ok: false, reason: "providers.json: expected a top-level object" };
  const unknownTop = rejectUnknownFields(raw, ["providers", "default"], "providers.json");
  if (unknownTop !== undefined) return unknownTop;
  const rawProviders = raw.providers;
  if (!Array.isArray(rawProviders) || rawProviders.length === 0) {
    return { ok: false, reason: "providers.json: providers must be a non-empty array" };
  }
  const providers: ProviderProfile[] = [];
  for (let index = 0; index < rawProviders.length; index += 1) {
    const entry = rawProviders[index];
    const parsed = parseProfile(entry, index);
    if (!parsed.ok) return parsed;
    if (providers.some((p) => p.name === parsed.value.name)) {
      return { ok: false, reason: `providers[${index}]: duplicate provider name "${parsed.value.name}"` };
    }
    providers.push(parsed.value);
  }
  const parsedDefault = synthesizeDefault(raw.default, providers);
  if (!parsedDefault.ok) return parsedDefault;
  return { ok: true, value: { providers, default: parsedDefault.value } };
}

const EXAMPLE = `{
  "providers": [{
    "name": "glm",
    "protocol": "anthropic",
    "baseUrl": "https://api.example.com",
    "apiKey": "sk-...",
    "models": ["glm-4.7"]
  }]
}`;

/** IO 层：读文件 + 解析；缺席/坏 JSON 给出可行动指引（路径 + 示例 + 权限建议） */
function errnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export async function readProvidersConfig(path: string): Promise<Result<ProvidersConfig>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") {
      return {
        ok: false,
        reason: `no providers config at ${path} — create it (chmod 600 recommended) with e.g.:\n${EXAMPLE}`,
      };
    }
    return { ok: false, reason: `cannot read ${path}: ${code ?? "io error"}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `${path}: invalid JSON (${error instanceof Error ? error.message : "parse error"})` };
  }
  const parsed = parseProvidersConfig(json);
  if (!parsed.ok) return { ok: false, reason: `${path}: ${parsed.reason}` };
  return parsed;
}
