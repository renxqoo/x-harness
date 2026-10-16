import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describeSource } from "./benchmark/describe-source";
import { cpus } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { summarizeSamples } from "./benchmark/summarize-samples";
import type { Engine, Sample, Scenario } from "./benchmark/types";

const directory = process.argv[2]; assert(directory && isAbsolute(directory), "Pass the absolute Cordis checkout directory");
assert.equal(process.execArgv.length, 0, "Benchmark workers use the default VM flags; launch without outer runtime options");
const sources = { harness: resolve(import.meta.dir, "../core/src"), cordis: resolve(directory, "packages/core/src") };
const configs = { harness: { root: resolve(import.meta.dir, "../../.."), locks: ["bun.lock", "package.json", "packages/v2/package.json"], paths: ["packages/v2/core", "packages/v2/scripts/benchmark", "packages/v2/scripts/benchmark-kernel.ts", "bun.lock"] },
  cordis: { root: directory, locks: ["yarn.lock", "package.json", "packages/core/package.json"], paths: ["packages/core", "yarn.lock"] } };
const provenance = { harness: await describeSource(sources.harness, configs.harness), cordis: await describeSource(sources.cordis, configs.cordis) };
const meter = async () => {
  const files = [...new Bun.Glob("benchmark/**/*.ts").scanSync({ cwd: import.meta.dir })].filter((file) => !file.split("/").includes("__test__")).sort();
  files.push("benchmark-kernel.ts"); const hash = createHash("sha256");
  for (const file of files) { hash.update(file + "\0"); hash.update(await readFile(resolve(import.meta.dir, file))); hash.update("\0"); }
  return hash.digest("hex");
};
const meterHash = await meter();
const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BUN_JSC_") && !["NODE_OPTIONS", "BUN_OPTIONS"].includes(key))), BUN_JSC_useJIT: "true" };
const samples: (Sample & { round: number })[] = [];
for (const scenario of ["plain", "unused", "nested", "selective"] as const) {
  for (let round = 0; round < 7; round++) {
    for (const engine of (round % 2 ? ["harness", "cordis"] : ["cordis", "harness"]) as Engine[]) {
      const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn([process.execPath, resolve(import.meta.dir, "benchmark/measure-service.ts"), engine, scenario, directory], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: environment });
      const timer = setTimeout(() => child.kill(), 30000);
      try {
        const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        assert.equal(status, 0, stderr); assert.equal(stderr, "");
        const sample = JSON.parse(stdout) as Sample;
        assert.equal(sample.worker.bun, Bun.version); assert.deepEqual(sample.worker.execArgv, []); assert.equal(sample.worker.jit, "true");
        assert.equal(sample.engine, engine); assert.equal(sample.scenario, scenario);
        assert.equal(sample.iterations, 10000); assert.equal(sample.batch, 100); assert.equal(sample.batchMeanUs.length, 100);
        let increments = 10000;
        if (scenario === "nested") increments = 40000;
        else if (scenario === "selective") increments = 20000;
        assert.equal(sample.checksum, 49995000 + increments);
        samples.push({ ...sample, round });
      } finally { clearTimeout(timer); child.kill(); }
    }
  }
}
const summary = (["plain", "unused", "nested", "selective"] as Scenario[]).flatMap((scenario) => (["cordis", "harness"] as Engine[]).map((engine) => summarizeSamples(samples.filter((sample) => sample.engine === engine && sample.scenario === scenario))));
assert.equal(await meter(), meterHash, "Measurement scripts changed during sampling");
assert.deepEqual(await describeSource(sources.harness, configs.harness), provenance.harness, "Harness source or dependencies changed during sampling");
assert.deepEqual(await describeSource(sources.cordis, configs.cordis), provenance.cordis, "Cordis source or dependencies changed during sampling");
process.stdout.write(JSON.stringify({ runtime: { bun: Bun.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
  sources, provenance, meterHash, workerConfiguration: { execArgv: [], BUN_JSC_useJIT: "true", otherJscFlags: "cleared", NODE_OPTIONS: "cleared", BUN_OPTIONS: "cleared" }, warmup: 2000, samplesPerScenario: 7,
  semantics: { cordis: "cached object service; dependency access traced through Context; no automatic per-call Work/deadline/cancellation/budget", harness: "cached managed service; per-call Work/deadline/cancellation/budget/actual settlement/revocation" },
  measurementScope: "fixed warmup; not verified JIT/GC steady state; timed loop includes identical result assertions and checksum accumulation",
  latencyUnit: "microseconds; batchMeanUs is a distribution of 100-call batch means, not individual request tail latency", summary, samples }, null, 2) + "\n");
