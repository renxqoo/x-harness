import { readCatalog, buildAssemblySnapshot } from "./shared/catalog.ts";
import { createAnthropicCompatAdapter, createOpenaiCompatAdapter } from "@x-harness/llm";
import type { LlmAdapter } from "@x-harness/llm";
import { createScriptAdapter, scriptFromEnv } from "./shared/script-adapter.ts";
import type { ScriptStep } from "./shared/script-adapter.ts";

export interface CatalogSnapshot {
  adapters: readonly LlmAdapter[];
  dial: { provider: string; model: string };
  resolveProviderOf(model: string): string | undefined;
  dialable(ref: string): boolean;
  fallbackDial: { model: string; provider: string } | undefined;
}

async function readCredentials(agentDir: string): Promise<Record<string, string>> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    const parsed = JSON.parse(await readFile(join(agentDir, "credentials.json"), "utf8")) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      const key = (value as { apiKey?: unknown })?.apiKey;
      if (typeof key === "string" && key !== "") out[name] = key;
    }
    return out;
  } catch {
    return {};
  }
}

export async function loadCatalogSnapshot(agentDir: string, env: Record<string, string | undefined>): Promise<CatalogSnapshot> {
  const catalog = await readCatalog(agentDir);
  const credentials = await readCredentials(agentDir);
  const providers = buildAssemblySnapshot(catalog, credentials, env);
  const adapters: LlmAdapter[] = [];
  const registered = new Set<string>();
  const modelsByProvider = new Map<string, readonly string[]>();
  for (const provider of providers) {
    if (provider.apiKey === "") continue;
    registered.add(provider.provider);
    modelsByProvider.set(provider.provider, provider.models);
    adapters.push(
      provider.protocol === "anthropic"
        ? createAnthropicCompatAdapter({ name: provider.provider, baseUrl: provider.baseUrl, apiKey: provider.apiKey })
        : createOpenaiCompatAdapter({ name: provider.provider, baseUrl: provider.baseUrl, apiKey: provider.apiKey }),
    );
  }
  const dial = { provider: catalog.defaults.provider, model: catalog.defaults.model };
  const fallbackDial = registered.has(dial.provider) ? dial : undefined;
  const resolveProviderOf = (model: string): string | undefined => {
    const owners = [...modelsByProvider.entries()].filter(([, models]) => models.includes(model)).map(([name]) => name);
    return owners.length === 1 && registered.has(owners[0] as string) ? owners[0] : undefined;
  };
  const dialable = (ref: string): boolean => {
    const slash = ref.indexOf("/");
    if (slash > 0 && slash < ref.length - 1) {
      const provider = ref.slice(0, slash);
      const model = ref.slice(slash + 1);
      return registered.has(provider) && (modelsByProvider.get(provider)?.includes(model) ?? false);
    }
    return resolveProviderOf(ref) !== undefined;
  };
  return { adapters, dial, resolveProviderOf, dialable, fallbackDial };
}

export function scriptSnapshotOf(env: Record<string, string | undefined>): CatalogSnapshot | undefined {
  if (env["HUB_WORKER_PROVIDER"] !== "script") return undefined;
  const steps = scriptFromEnv(env);
  const adapter = createScriptAdapter(steps as readonly ScriptStep[]);
  return {
    adapters: [adapter],
    dial: { provider: "script", model: "script-1" },
    resolveProviderOf: (model) => (model === "script-1" ? "script" : undefined),
    dialable: (ref) => ref === "script" || ref === "script-1" || ref === "script/script-1",
    fallbackDial: { provider: "script", model: "script-1" },
  };
}
