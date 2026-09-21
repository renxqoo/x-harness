// host 模型/凭据域处理器（DESIGN §3.6——从 host-commands 按行数预算拆出）：
// get_models/set_model_override/auth 三命令与校验/覆写 helper 单点。
import { readCatalog } from "../shared/catalog.ts";
import { createCredentials, redact } from "./credentials.ts";
import type { CredentialStore } from "./credentials.ts";
import { hubError, type HubErrorShape } from "../shared/errors.ts";
import { updateProvidersFile } from "./models-admin.ts";

export interface RespondFn {
  (id: string | undefined, command: string, result: { data?: unknown; error?: HubErrorShape }): void;
}

/** 非法数值回显的数组元素面：null/undefined 空串、嵌套数组递归（String 语义） */
function arrayElementText(value: unknown): string {
  if (value === null) return "";
  if (Array.isArray(value)) return value.map(arrayElementText).join(",");
  if (typeof value === "object") return "[object Object]";
  if (typeof value === "undefined") return "";
  return String(value);
}

/** 非法数值回显：保持 String 语义（数组 join/对象 [object Object]——错误文案不变） */
function invalidValueText(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map(arrayElementText).join(",");
  if (typeof value === "object") return "[object Object]";
  return String(value);
}

/** set_model_override 校验段：字段组合与数值合法性（错误文案单点——恒 invalid_input 族） */
export function validateOverrideInput(
  input: { contextWindow?: unknown; maxTokens?: unknown; remove?: unknown },
): { ok: true; remove: boolean; contextWindow: unknown; maxTokens: unknown } | { ok: false; error: HubErrorShape } {
  const remove = input.remove === true;
  const cw = input.contextWindow;
  const mt = input.maxTokens;
  if (!remove && cw === undefined && mt === undefined) {
    return { ok: false, error: hubError("invalid_input", "invalid: nothing to set (provide contextWindow/maxTokens or remove)") };
  }
  for (const value of [cw, mt]) {
    if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
      return { ok: false, error: hubError("invalid_input", `invalid: ${invalidValueText(value)} must be a positive integer or null`) };
    }
  }
  if (remove && (cw !== undefined || mt !== undefined)) {
    return { ok: false, error: hubError("invalid_input", "invalid: remove is exclusive with field updates") };
  }
  return { ok: true, remove, contextWindow: cw, maxTokens: mt };
}

type OverrideFile = { modelOverrides?: Record<string, { contextWindow?: number; maxOutputTokens?: number }> };

/** overrides 键变更：remove 删键；字段更新后空键自删 */
function applyOverrideEntry(file: OverrideFile, key: string, fields: { remove: boolean; contextWindow: unknown; maxTokens: unknown }): void {
  file.modelOverrides ??= {};
  if (fields.remove) {
    delete file.modelOverrides[key];
    return;
  }
  const entry = file.modelOverrides[key] ?? {};
  if (fields.contextWindow === null) delete entry.contextWindow;
  else if (typeof fields.contextWindow === "number") entry.contextWindow = fields.contextWindow;
  if (fields.maxTokens === null) delete entry.maxOutputTokens;
  else if (typeof fields.maxTokens === "number") entry.maxOutputTokens = fields.maxTokens;
  if (entry.contextWindow === undefined && entry.maxOutputTokens === undefined) delete file.modelOverrides[key];
  else file.modelOverrides[key] = entry;
}

/** 刷新后模型对象（附录 B 形状——单点构造；reasoning 恒在场随条目透传，input 条件在场） */
export function modelShapeOf(entry: { model: string; provider: string; contextWindow?: number; maxTokens?: number; reasoning: boolean; input?: ("text" | "image")[]; cost?: Record<string, number>; source: "preset" | "custom" } | undefined): Record<string, unknown> | undefined {
  if (entry === undefined) return undefined;
  return {
    id: entry.model,
    provider: entry.provider,
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
    reasoning: entry.reasoning,
    ...(entry.input !== undefined ? { input: entry.input } : {}),
    ...(entry.cost !== undefined ? { cost: entry.cost } : {}),
    source: entry.source,
  };
}

/** auth/list 三态：有存 key/档案字面 → api-key；仅 env 键名 → preset-env；皆无 → none */
function authTypeOf(hasLiteral: boolean, hasEnvName: boolean): "api-key" | "preset-env" | "none" {
  if (hasLiteral) return "api-key";
  if (hasEnvName) return "preset-env";
  return "none";
}

export interface ModelsAuthSpec {
  readonly agentDir: string;
  readonly respond: RespondFn;
  readonly emitClient: (line: string) => void;
  readonly refreshSnapshot: () => Promise<void>;
}

export function createModelsAuthCommands(spec: ModelsAuthSpec): {
  credentials: CredentialStore;
  setModelOverride(input: { provider?: unknown; modelId?: unknown; contextWindow?: unknown; maxTokens?: unknown; remove?: unknown }, id: string | undefined): Promise<void>;
  getModels(id: string | undefined): Promise<void>;
  authList(id: string | undefined): Promise<void>;
  authSetApiKey(input: { [key: string]: unknown }, id: string | undefined): Promise<void>;
  authRemoveKey(input: { [key: string]: unknown }, id: string | undefined): Promise<void>;
} {
  const credentials = createCredentials(spec.agentDir);

  async function setModelOverride(
    input: { provider?: unknown; modelId?: unknown; contextWindow?: unknown; maxTokens?: unknown; remove?: unknown },
    id: string | undefined,
  ): Promise<void> {
    const provider = typeof input.provider === "string" ? input.provider : "";
    const modelId = typeof input.modelId === "string" ? input.modelId : "";
    const catalog = await readCatalog(spec.agentDir);
    const known = catalog.entries.some((e) => e.provider === provider && e.model === modelId);
    if (!known) {
      spec.respond(id, "set_model_override", {
        error: hubError("model_unavailable", `unknown model preset: ${modelId} (available: ${catalog.entries.map((e) => e.model).join(", ")})`),
      });
      return;
    }
    const verdict = validateOverrideInput(input);
    if (!verdict.ok) {
      spec.respond(id, "set_model_override", { error: verdict.error });
      return;
    }
    const key = `${provider}::${modelId}`;
    await updateProvidersFile(spec.agentDir, (file) => {
      applyOverrideEntry(file, key, verdict);
      return file;
    });
    // 热刷新 = 每次读取现算（readCatalog 无缓存）——响应回显刷新后模型对象
    const refreshed = await readCatalog(spec.agentDir);
    const entry = refreshed.entries.find((e) => e.provider === provider && e.model === modelId);
    spec.respond(id, "set_model_override", { data: { model: modelShapeOf(entry) } });
  }

  return {
    credentials,
    setModelOverride,
    async getModels(id) {
      const catalog = await readCatalog(spec.agentDir);
      if (catalog.degraded) {
        const { hubErrorFrame } = await import("../protocol/frames.ts");
        spec.emitClient(hubErrorFrame("providers.json unreadable; preset-only catalog"));
      }
      spec.respond(id, "get_models", {
        data: catalog.entries.map((e) => modelShapeOf(e)),
      });
    },
    async authList(id) {
      const catalog = await readCatalog(spec.agentDir);
      const creds = await credentials.read();
      const providers = catalog.profiles.map((profile) => ({
        provider: profile.name,
        type: authTypeOf(creds.keys[profile.name] !== undefined || profile.apiKey !== undefined, profile.apiKeyEnv !== undefined),
      }));
      spec.respond(id, "auth/list", { data: { providers } });
    },
    async authSetApiKey(input, id) {
      const provider = typeof input.provider === "string" ? input.provider : "";
      const apiKey = typeof input.apiKey === "string" ? input.apiKey : "";
      const catalog = await readCatalog(spec.agentDir);
      if (!catalog.profiles.some((profile) => profile.name === provider)) {
        spec.respond(id, "auth/set_api_key", { error: hubError("invalid_input", redact(`auth provider not in catalog: ${provider}`, [apiKey])) });
        return;
      }
      if (apiKey === "") {
        spec.respond(id, "auth/set_api_key", { error: hubError("invalid_input", "invalid: apiKey required") });
        return;
      }
      try {
        await credentials.setKey(provider, apiKey);
        await spec.refreshSnapshot(); // 新 key 立即可注入后续 spawn
        spec.respond(id, "auth/set_api_key", {});
      } catch (error) {
        spec.respond(id, "auth/set_api_key", { error: hubError("io_failed", redact(String(error), [apiKey])) });
      }
    },
    async authRemoveKey(input, id) {
      const provider = typeof input.provider === "string" ? input.provider : "";
      await credentials.removeKey(provider);
      await spec.refreshSnapshot(); // 撤 key 后续 spawn 不再注入
      spec.respond(id, "auth/remove_key", {});
    },
  };
}
