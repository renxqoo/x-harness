import type { AssemblyProvider } from "./catalog-types.ts";
import type { DialFact } from "./meta-fold.ts";

export interface WorkerCatalog {
  readonly providers: readonly AssemblyProvider[];
  readonly default: DialFact;
  /** 模型元数据表：键 = `provider\0model`（modelKeyOf）。跨渠道同名模型（如 GLM 与
   *  GML2 都有 glm-5.3-flash）必须各存一条——单键表会被后写者覆盖，把已配对的
   *  模型级窗口抹成缺省，落到兜底假值。 */
  readonly modelMeta: Readonly<Record<string, WorkerModelMeta>>;
}

/** 模型元数据表的组合键（provider 与 model 用 NUL 分隔——与 token-meter 的
 *  routeKey 同律；模型 id 与渠道名都不会含 NUL）。 */
export function modelKeyOf(dial: { provider: string; model: string }): string {
  return `${dial.provider}\u0000${dial.model}`;
}

/** 模型元数据查表单点（键必须先组合——直取 `modelMeta[dial.model]` 是单键表时期的
 *  漏法，跨渠道同名会串）。 */
export function modelMetaOf(catalog: WorkerCatalog, dial: { provider: string; model: string }): WorkerModelMeta | undefined {
  return catalog.modelMeta[modelKeyOf(dial)];
}

export interface WorkerModelMeta {
  readonly reasoning?: boolean;
  readonly input?: readonly ("text" | "image")[];
  readonly contextWindow?: number;
}

interface SnapshotJson {
  readonly providers?: readonly AssemblyProvider[];
  readonly default?: { readonly provider?: unknown; readonly model?: unknown };
  readonly modelMeta?: Readonly<Record<string, WorkerModelMeta>>;
}

function validMaxByModel(raw: unknown): Readonly<Record<string, number>> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [model, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) out[model] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function validProviders(raw: readonly AssemblyProvider[] | undefined): readonly AssemblyProvider[] {
  if (!Array.isArray(raw)) return [];
  const out: AssemblyProvider[] = [];
  for (const p of raw) {
    if (
      typeof p?.provider !== "string" || p.provider === "" ||
      (p.protocol !== "anthropic" && p.protocol !== "openai") ||
      typeof p.baseUrl !== "string" ||
      !Array.isArray(p.models)
    ) {
      continue;
    }
    const { maxOutputTokensByModel: rawByModel, ...rest } = p;
    const maxOutputTokensByModel = validMaxByModel(rawByModel);
    out.push({
      ...rest,
      ...(maxOutputTokensByModel !== undefined ? { maxOutputTokensByModel } : {}),
    });
  }
  return out;
}

export function workerCatalogFromEnv(env: Readonly<Record<string, string | undefined>>): WorkerCatalog {
  const raw = env["HUB_WORKER_PROVIDERS"];
  if (raw === undefined || raw.trim() === "") return { providers: [], default: { provider: "", model: "" }, modelMeta: {} };
  let parsed: SnapshotJson;
  try {
    parsed = JSON.parse(raw) as SnapshotJson;
  } catch {
    return { providers: [], default: { provider: "", model: "" }, modelMeta: {} };
  }
  const providers = validProviders(parsed.providers);
  const defaults = defaultsOf(parsed, providers);
  return { providers, default: defaults, modelMeta: parsed.modelMeta ?? {} };
}

function defaultsOf(parsed: SnapshotJson, providers: readonly AssemblyProvider[]): DialFact {
  const def = parsed.default;
  if (def !== undefined && typeof def.provider === "string" && typeof def.model === "string") {
    return { provider: def.provider, model: def.model };
  }
  const fallback = providers[0];
  if (fallback !== undefined) return { provider: fallback.provider, model: fallback.models[0] ?? "" };
  return { provider: "", model: "" };
}

export function scriptCatalog(): WorkerCatalog {
  return {
    providers: [{ provider: "script", protocol: "anthropic", baseUrl: "script://local", apiKey: "", models: ["script-1"], contextWindow: 200_000 }],
    default: { provider: "script", model: "script-1" },
    modelMeta: { [modelKeyOf({ provider: "script", model: "script-1" })]: { reasoning: true, input: ["text", "image"] } },
  };
}

export function resolveWorkerCatalog(env: Readonly<Record<string, string | undefined>>): WorkerCatalog {
  if (env["HUB_WORKER_PROVIDER"] === "script") return scriptCatalog();
  return workerCatalogFromEnv(env);
}

export function catalogEntryOf(catalog: WorkerCatalog, dial: DialFact): AssemblyProvider | undefined {
  return catalog.providers.find((p) => p.provider === dial.provider && p.models.includes(dial.model));
}

export function catalogModelIds(catalog: WorkerCatalog): string[] {
  const out: string[] = [];
  for (const provider of catalog.providers) out.push(...provider.models);
  return out;
}
