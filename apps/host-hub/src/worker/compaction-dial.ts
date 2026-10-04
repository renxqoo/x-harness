import type { Plugin } from "@x-harness/core";
import { autoCompactKit, compactionKit } from "@x-harness/harness";
import { commandCompactPlugin } from "@x-harness/compaction";
import type { WorkerCatalog } from "../shared/worker-catalog.ts";
import { catalogEntryOf } from "../shared/worker-catalog.ts";
import { contextWindowOf } from "./assembly.ts";

export interface SummarizerFaceWire {
  readonly model: string;
  readonly provider: string;
  readonly contextWindow: number | undefined;
}

function summarizerDialOf(catalog: WorkerCatalog, dial: { provider: string; model: string }, override: { provider: string; model: string } | undefined): SummarizerFaceWire | undefined {
  if (override !== undefined) {
    if (catalogEntryOf(catalog, override) !== undefined) {
      return { ...override, contextWindow: contextWindowOf(catalog, override) };
    }
    process.stderr.write(`hub:worker: compaction.summarizer override '${override.provider}/${override.model}' not in catalog, falling back\n`);
  }
  const owner = catalog.providers.find((p) => p.provider === dial.provider);
  const flash = owner?.models.find((m) => m.includes("flash"));
  if (owner !== undefined && flash !== undefined) return { provider: owner.provider, model: flash, contextWindow: contextWindowOf(catalog, { provider: owner.provider, model: flash }) };
  process.stderr.write(`hub:worker: no flash model under provider '${dial.provider}', compaction summarizer stays on main dial\n`);
  return undefined;
}

export function compactionPluginsOf(fields: {
  readonly catalog: WorkerCatalog;
  readonly contextWindow: number | undefined;
  readonly dial: { provider: string; model: string };
  readonly overrides: Record<string, unknown>;
  readonly summarizerModel: string | undefined;
  readonly summarizerProvider: string | undefined;
}): readonly Plugin[] {
  const { catalog, contextWindow, dial, overrides } = fields;
  if (contextWindow === undefined) return [];
  const overrideDial = fields.summarizerModel !== undefined
    ? { provider: fields.summarizerProvider ?? dial.provider, model: fields.summarizerModel }
    : undefined;
  const face = summarizerDialOf(catalog, dial, overrideDial);
  const summarizerContextWindow = face?.contextWindow ?? contextWindow;
  return [
    ...compactionKit({
      contextWindow,
      summarizer: face === undefined
        ? { model: dial.model, provider: dial.provider }
        : { model: face.model, provider: face.provider, ...(summarizerContextWindow !== undefined ? { contextWindow: summarizerContextWindow } : {}) },
      ...overrides,
    }),
    ...autoCompactKit({ contextWindow }),
    commandCompactPlugin,
  ];
}
