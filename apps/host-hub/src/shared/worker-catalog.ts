// worker 装配快照（DESIGN §3.6/§5）：HUB_WORKER_PROVIDERS 单通道注入的目录快照
// （apiKey 已解析）——worker 不读 providers.json/credentials；set_model/thinking
// 校验与 adapter 构造共用。测试缝 = HUB_WORKER_PROVIDER=script（script-adapter 单
// provider 快照）。
import type { AssemblyProvider } from "./catalog-types.ts";
import type { DialFact } from "./meta-fold.ts";

export interface WorkerCatalog {
  readonly providers: readonly AssemblyProvider[];
  readonly default: DialFact;
  /** 逐模型元数据（reasoning 面——thinking 校验判据；input 面——images 能力门判据） */
  readonly modelMeta: Readonly<Record<string, { readonly reasoning?: boolean; readonly input?: readonly ("text" | "image")[] }>>;
}

export interface WorkerModelMeta {
  readonly reasoning?: boolean;
  readonly input?: readonly ("text" | "image")[];
}

/** 快照 JSON 形状（host buildAssemblySnapshot 产出与此处消费同契约） */
interface SnapshotJson {
  readonly providers?: readonly AssemblyProvider[];
  readonly default?: { readonly provider?: unknown; readonly model?: unknown };
  readonly modelMeta?: Readonly<Record<string, WorkerModelMeta>>;
}

function validProviders(raw: readonly AssemblyProvider[] | undefined): readonly AssemblyProvider[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p) =>
      typeof p?.provider === "string" && p.provider !== "" &&
      (p.protocol === "anthropic" || p.protocol === "openai") &&
      typeof p.baseUrl === "string" &&
      Array.isArray(p.models),
  ) as readonly AssemblyProvider[];
}

/** 从 env 解析快照；缺席/坏 JSON → 空目录（thread/start 显式 modelId 即失败——
 *  host 侧装配链保证生产恒在场，空态是显式可观察面不是静默降级） */
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

/** script 模式快照（HUB_WORKER_PROVIDER=script——script-adapter 单 provider）；
 *  script-1 声明 image 输入模态——携图全链测试不经能力门误拒 */
export function scriptCatalog(): WorkerCatalog {
  return {
    providers: [{ provider: "script", protocol: "anthropic", baseUrl: "script://local", apiKey: "", models: ["script-1"], contextWindow: 200_000 }],
    default: { provider: "script", model: "script-1" },
    modelMeta: { "script-1": { reasoning: true, input: ["text", "image"] } },
  };
}

/** 装配期目录解析（DESIGN §5 注入缝）：script 模式 > 快照 > 空 */
export function resolveWorkerCatalog(env: Readonly<Record<string, string | undefined>>): WorkerCatalog {
  if (env["HUB_WORKER_PROVIDER"] === "script") return scriptCatalog();
  return workerCatalogFromEnv(env);
}

/** (provider, model) 目录内查——set_model / thinking 校验面 */
export function catalogEntryOf(catalog: WorkerCatalog, dial: DialFact): AssemblyProvider | undefined {
  return catalog.providers.find((p) => p.provider === dial.provider && p.models.includes(dial.model));
}

/** 目录内全部模型 id（错误面 available 清单） */
export function catalogModelIds(catalog: WorkerCatalog): string[] {
  const out: string[] = [];
  for (const provider of catalog.providers) out.push(...provider.models);
  return out;
}
