import assert from "node:assert/strict";
import { openCordis } from "./open-cordis";
import { openHarness } from "./open-harness";
import type { Engine, Sample, Scenario } from "./types";

const [engine, scenario, directory] = process.argv.slice(2);
assert(engine === "harness" || engine === "cordis");
assert(scenario === "plain" || scenario === "unused" || scenario === "nested" || scenario === "selective");
assert(directory);
const target = engine === "harness" ? await openHarness(scenario) : await openCordis(directory, scenario);
const iterations = 10000;
const batch = 100;
let depth = 1;
if (scenario === "nested") depth = 4;
else if (scenario === "selective") depth = 2;
const batchMeanUs: number[] = [];
let checksum = 0;
let elapsedMs = 0;
try {
  for (let i = 0; i < 2000; i++) { const result = await target.endpoint.read(i); assert(result.ok && result.value === i + depth); }
  for (let offset = 0; offset < iterations; offset += batch) {
    const start = performance.now();
    for (let i = offset; i < offset + batch; i++) {
      const result = await target.endpoint.read(i); assert(result.ok && result.value === i + depth);
      checksum += result.value;
    }
    const elapsed = performance.now() - start;
    elapsedMs += elapsed; batchMeanUs.push(elapsed * 1000 / batch);
  }
} finally { await target.close(); }
assert.equal(checksum, iterations * (iterations - 1) / 2 + iterations * depth);
const sample: Sample = { worker: { bun: Bun.version, execArgv: process.execArgv, jit: process.env.BUN_JSC_useJIT }, engine: engine as Engine, scenario: scenario as Scenario, iterations, batch, checksum, elapsedMs, batchMeanUs };
process.stdout.write(JSON.stringify(sample) + "\n");
