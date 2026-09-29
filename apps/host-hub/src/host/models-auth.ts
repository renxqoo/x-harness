import { readCatalog } from "../shared/catalog.ts";
import { createCredentials, redact } from "./credentials.ts";
import type { CredentialStore } from "./credentials.ts";
import { hubError, type HubErrorShape } from "../shared/errors.ts";
import { updateProvidersFile } from "./models-admin.ts";

export interface RespondFn {
  (id: string | undefined, command: string, result: { data?: unknown; error?: HubErrorShape }): void;
}

function arrayElementText(value: unknown): string {
  if (value === null) return "";
  if (Array.isArray(value)) return value.map(arrayElementText).join(",");
  if (typeof value === "object") return "[object Object]";
  if (typeof value === "undefined") return "";
  return String(value);
}

function invalidValueText(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map(arrayElementText).join(",");
  if (typeof value === "object") return "[object Object]";
  return String(value);
}

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
  readonly broadcastCatalogReload: () => void;
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
    await spec.refreshSnapshot();
    spec.broadcastCatalogReload();
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
        await spec.refreshSnapshot();
        spec.respond(id, "auth/set_api_key", {});
      } catch (error) {
        spec.respond(id, "auth/set_api_key", { error: hubError("io_failed", redact(String(error), [apiKey])) });
      }
    },
    async authRemoveKey(input, id) {
      const provider = typeof input.provider === "string" ? input.provider : "";
      await credentials.removeKey(provider);
      await spec.refreshSnapshot();
      spec.respond(id, "auth/remove_key", {});
    },
  };
}
