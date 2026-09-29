import { llmRuntime } from "@x-harness/llm";
import type { LlmRuntime } from "@x-harness/llm";
import { workerCatalogFromEnv } from "../shared/worker-catalog.ts";
import type { WorkerCatalog } from "../shared/worker-catalog.ts";
import { buildAdapters } from "./assembly.ts";
import type { WorkerRuntime } from "./worker-commands.ts";

export function parseReloadCatalog(raw: unknown): WorkerCatalog | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const catalog = workerCatalogFromEnv({ HUB_WORKER_PROVIDERS: JSON.stringify(raw) });
  return catalog.providers.length > 0 ? catalog : undefined;
}

export function registerMissingAdapters(runtime: LlmRuntime, next: WorkerCatalog): boolean {
  const offs: Array<() => void> = [];
  try {
    for (const adapter of buildAdapters(next, undefined)) {
      if (runtime.hasAdapter(adapter.name)) continue;
      offs.push(runtime.registerAdapter(adapter));
    }
  } catch {
    for (const off of offs) off();
    return false;
  }
  return true;
}

export function swapWorldAdapters(rt: WorkerRuntime, next: WorkerCatalog): boolean {
  const world = rt.state.world;
  const runtime = world?.ctx.tryUse(llmRuntime);
  if (world === undefined || runtime === undefined) return false;
  if (rt.state.scriptAdapter !== undefined) return true;
  return registerMissingAdapters(runtime, next);
}
