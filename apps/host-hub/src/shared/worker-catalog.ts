// worker 装配快照（DESIGN §3.6/§5）：HUB_WORKER_PROVIDERS 单通道注入的目录快照
// （apiKey 已解析）——worker 不读 providers.json/credentials；set_model/thinking
// 校验与 adapter 构造共用。测试缝 = HUB_WORKER_PROVIDER=script（script-adapter 单
// provider 快照）。
import type { AssemblyProvider } from "./catalog-types.ts";
import type { DialFact } from "./meta-fold.ts";

export interface WorkerCatalog {
  readonly providers: readonly AssemblyProvider[];
  readonly default: DialFact;
  /** 逐模型元数据（reasoning 面——thinking 校验判据；input 面——images 能力门判据；
   *  contextWindow 面——窗口解析模型级优先） */
  readonly modelMeta: Readonly<Record<string, WorkerModelMeta>>;
}

export interface WorkerModelMeta {
  readonly reasoning?: boolean;
  readonly input?: readonly ("text" | "image")[];
  /** 模型级上下文窗口（窗口解析模型级优先——同档案多模型窗口不同的精确面） */
  readonly contextWindow?: number;
}

/** 快照 JSON 形状（host buildAssemblySnapshot 产出与此处消费同契约） */
interface SnapshotJson {
  readonly providers?: readonly AssemblyProvider[];
  readonly default?: { readonly provider?: unknown; readonly model?: unknown };
  readonly modelMeta?: Readonly<Record<string, WorkerModelMeta>>;
}

/** 逐模型输出上限形状：值须正整数（垃圾成员剔除——provider 整体保留） */
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
    // 逐模型输出上限整字段净化：垃圾形状（非对象/全垃圾成员）剔除字段本身，不透传
    const { maxOutputTokensByModel: rawByModel, ...rest } = p;
    const maxOutputTokensByModel = validMaxByModel(rawByModel);
    out.push({
      ...rest,
      ...(maxOutputTokensByModel !== undefined ? { maxOutputTokensByModel } : {}),
    });
  }
  return out;
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
