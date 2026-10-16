import assert from "node:assert/strict";
import { createHost, definePlugin, defineService } from "../../core/src/index";
import type { Endpoint, Scenario, Target } from "./types";

export async function openHarness(scenario: Scenario): Promise<Target> {
  const depth = scenario === "nested" ? 4 : 1;
  const unused = scenario === "unused" || scenario === "selective" ? 16 : 0;
  const selected = Array.from({ length: unused }, () => 0); let consumerCalls = 0;
  const tokens = Array.from({ length: unused + depth }, (_, i) => {
    const result = defineService<Endpoint>({ name: i < unused ? `unused${i}` : `step${i - unused}`, methods: { read: {} } });
    assert(result.ok); return result.value;
  });
  const created = createHost(); assert(created.ok); const host = created.value;
  if (unused) {
    const provides = Object.fromEntries(tokens.slice(0, unused).map((token, n) => [`unused${n}`, token]));
    const implementations = Object.fromEntries(Object.keys(provides).map((name, n) => [name, { async read(input: number) { if (scenario === "selective") selected[n]!++; return { ok: true as const, value: input + 1 }; } }]));
    assert((await host.install([definePlugin({ name: "unused", provides, setup(ctx) { return ctx.service(implementations); } })])).ok);
  }
  for (let i = 0; i < depth; i++) {
    const current = tokens[unused + i]!;
    const requires = i ? { previous: tokens[unused + i - 1]! } : Object.fromEntries(tokens.slice(0, unused).map((token, n) => [`unused${n}`, token]));
    const installed = await host.install([definePlugin({ name: `step${i}`, provides: { current }, requires,
      setup(ctx) { return ctx.service({ current: { async read(input, call) {
        if (scenario === "selective") { consumerCalls++; return call.deps.unused0!.read(input + 1); }
        return i ? call.deps.previous!.read(input + 1) : { ok: true, value: input + 1 };
      } } }); },
    })]); assert(installed.ok);
  }
  const acquired = host.use(tokens.at(-1)!); assert(acquired.ok);
  return { endpoint: acquired.value, async close() {
    if (scenario === "selective") { assert(consumerCalls > 0); assert.deepEqual(selected, [consumerCalls, ...Array.from({ length: unused - 1 }, () => 0)]); }
    assert((await host.close()).ok);
    const state = host.inspect();
    assert.equal(state.plugins.length, 0); assert.equal(state.activeCalls, 0); assert.equal(state.serviceLeases, 0); assert.equal(state.effects, 0);
  } };
}
