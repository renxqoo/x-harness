import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Endpoint, Scenario, Target } from "./types";

interface CordisContext {
  [name: string]: unknown;
  provide(name: string, service: Endpoint): void;
  plugin(plugin: { name?: string; inject?: string[]; apply(ctx: CordisContext): void } | ((ctx: CordisContext) => void)): PromiseLike<unknown>;
  fiber: { dispose(): Promise<void> };
  registry: { size: number };
}

export async function openCordis(directory: string, scenario: Scenario): Promise<Target> {
  const module = await import(pathToFileURL(resolve(directory, "packages/core/src/index.ts")).href) as { Context: new () => CordisContext };
  const host = new module.Context();
  const depth = scenario === "nested" ? 4 : 1;
  const unused = scenario === "unused" || scenario === "selective" ? 16 : 0;
  const selected = Array.from({ length: unused }, () => 0); let consumerCalls = 0;
  if (unused) await host.plugin((ctx) => {
    for (let i = 0; i < unused; i++) ctx.provide(`unused${i}`, { async read(input) { if (scenario === "selective") selected[i]!++; return { ok: true, value: input + 1 }; } });
  });
  for (let i = 0; i < depth; i++) await host.plugin({
    name: `step${i}`, inject: i ? [`step${i - 1}`] : Array.from({ length: unused }, (_, n) => `unused${n}`),
    apply(ctx) {
      ctx.provide(`step${i}`, { async read(input) {
        if (scenario === "selective") { consumerCalls++; return (ctx.unused0 as Endpoint).read(input + 1); }
        return i ? (ctx[`step${i - 1}`] as Endpoint).read(input + 1) : { ok: true, value: input + 1 };
      } });
    },
  });
  return { endpoint: host[`step${depth - 1}`] as Endpoint, async close() {
    if (scenario === "selective") { assert(consumerCalls > 0); assert.deepEqual(selected, [consumerCalls, ...Array.from({ length: unused - 1 }, () => 0)]); }
    await host.fiber.dispose(); assert.equal(host.registry.size, 0);
  } };
}
