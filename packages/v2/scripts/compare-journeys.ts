import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { describeSource } from "./benchmark/describe-source";
import { hashFiles } from "./comparison/hash-files";
import { runCommand } from "./comparison/run-command";
import { describeToolchain } from "./comparison/describe-toolchain";
import { checkDrainControl } from "./comparison/check-drain-control";
import type { Journeys } from "./comparison/types";

const directory = process.argv[2]; assert(directory && isAbsolute(directory), "Pass the absolute Cordis checkout directory");
assert.equal(process.execArgv.length, 0, "Launch without outer runtime options");
const workspace = resolve(import.meta.dir, ".."); const root = resolve(workspace, "../..");
const compiler = resolve(root, "node_modules/typescript/bin/tsc"); const cordisCompiler = resolve(directory, "node_modules/typescript/bin/tsc");
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BUN_JSC_") && !["NODE_OPTIONS", "BUN_OPTIONS"].includes(key)));
const source = async () => ({
  toolchains: { author: await describeToolchain(root, ["typescript", `@typescript/typescript-${process.platform}-${process.arch}`, "bun-types", "@types/node", "undici-types"]), declarations: await describeToolchain(directory, ["typescript", "cosmokit", "@standard-schema/spec", "@cordisjs/unyaml", "@types/node", "undici-types"]) },
  core: await describeSource(resolve(workspace, "core/src"), { root, locks: ["bun.lock", "package.json", "packages/v2/package.json", "node_modules/typescript/package.json", "packages/v2/tsconfig.json"], paths: ["packages/v2/core", "bun.lock"] }),
  application: await describeSource(resolve(workspace, "application/src"), { root, locks: ["packages/v2/application/package.json"], paths: ["packages/v2/application"] }),
  cordis: await describeSource(resolve(directory, "packages/core/src"), { root: directory, locks: ["yarn.lock", "package.json", "packages/core/package.json", "tsconfig.base.json", "packages/core/tsconfig.json", "node_modules/typescript/package.json"], paths: ["packages/core", "yarn.lock", "tsconfig.base.json"] }),
});
const toolFiles = () => [...new Bun.Glob("comparison/**/*").scanSync({ cwd: import.meta.dir, onlyFiles: true })].filter((file) => file.endsWith(".ts") || file.endsWith(".case")).concat("compare-journeys.ts", "benchmark/describe-source.ts");
const toolHash = await hashFiles(import.meta.dir, toolFiles()); const provenance = await source();
const temporary = await mkdtemp(resolve(tmpdir(), "kernel-journeys-"));
try {
  const declarations = resolve(temporary, "declarations"); await mkdir(declarations);
  await symlink(resolve(directory, "node_modules"), resolve(declarations, "node_modules"));
  const declarationArguments = ["-p", resolve(directory, "packages/core/tsconfig.json"), "--outDir", declarations, "--incremental", "false", "--composite", "false"];
  assert.equal(await runCommand([process.execPath, cordisCompiler, ...declarationArguments], environment), "");
  const declarationFiles = [...new Bun.Glob("*.d.ts").scanSync({ cwd: declarations })]; assert.equal(declarationFiles.length, 9);
  const declarationHash = await hashFiles(declarations, declarationFiles);
  const templates = [...new Bun.Glob("*.case").scanSync({ cwd: resolve(import.meta.dir, "comparison/cordis") })]; assert.equal(templates.length, 7);
  for (const mode of ["runtime", "types"] as const) {
    const output = resolve(temporary, mode); await mkdir(output);
    const cordis = mode === "runtime" ? resolve(directory, "packages/core/src") : declarations; const extension = mode === "runtime" ? "ts" : "js";
    const replacements = { __CORDIS_ENTRY__: resolve(cordis, `index.${extension}`), __CORDIS_CONTEXT__: resolve(cordis, `context.${extension}`), __CORDIS_EVENTS__: resolve(cordis, `events.${extension}`), __COMPARISON_TYPES__: resolve(import.meta.dir, "comparison/types.ts"), __UNWRAP__: resolve(import.meta.dir, "comparison/unwrap.ts"), __DEFER__: resolve(import.meta.dir, "comparison/defer.ts"), __SETTLE__: resolve(import.meta.dir, "comparison/settle.ts") };
    for (const template of templates) {
      let content = await readFile(resolve(import.meta.dir, "comparison/cordis", template), "utf8");
      for (const [name, path] of Object.entries(replacements)) content = content.replaceAll(name, path);
      assert(!/__\w+__/.test(content)); await writeFile(resolve(output, template.replace(/\.case$/, ".ts")), content);
    }
  }
  const strictArguments = ["--ignoreConfig", "--noEmit", "--strict", "--noUncheckedIndexedAccess", "--verbatimModuleSyntax", "--isolatedModules", "--skipLibCheck", "--allowImportingTsExtensions", "--target", "ESNext", "--lib", "ESNext,DOM", "--module", "ESNext", "--moduleResolution", "bundler", "--types", resolve(root, "node_modules/bun-types/index.d.ts")];
  const entries = { harness: resolve(import.meta.dir, "comparison/run-harness.ts"), cordis: resolve(temporary, "types/run.ts") };
  for (const entry of Object.values(entries)) assert.equal(await runCommand([process.execPath, compiler, ...strictArguments, entry], environment), "");
  const negativeControls: { engine: string; symptom: string; diagnostic: number }[] = [];
  for (const engine of ["harness", "cordis"] as const) {
    for (const [file, previous, invalid] of [
      ["read-service.ts", "async read(input) { return { ok: true", "async read(input: number) { return { ok: true"],
      ["deliver-event.ts", engine === "harness" ? 'ctx.emit("changed", value)' : 'host.parallel("journey/change", "changed")', engine === "harness" ? 'ctx.emit("changed", 42)' : 'host.parallel("journey/change", 42)'],
    ] as const) {
      const input = engine === "harness" ? resolve(import.meta.dir, "comparison/harness", file) : resolve(temporary, "types", file);
      let content = await readFile(input, "utf8"); assert.equal(content.split(previous).length, 2);
      const line = content.slice(0, content.indexOf(previous)).split("\n").length;
      content = content.replace(previous, invalid).replace(/from "(\.[^"]+)"/g, (_match, path: string) => `from ${JSON.stringify(resolve(dirname(input), path))}`);
      const output = resolve(temporary, `invalid-${engine}-${file}`); await writeFile(output, content);
      const diagnostics = await runCommand([process.execPath, compiler, ...strictArguments, output], environment, "type-error");
      const match = [...diagnostics.matchAll(/([^\s]+\.ts)\((\d+),\d+\): error TS(\d+)/g)].find((item) => basename(item[1]!) === basename(output) && Number(item[2]) === line && [2322, 2345, 2769].includes(Number(item[3])));
      assert(match, diagnostics); assert(!/error TS(?:2307|2688|5097)/.test(diagnostics), diagnostics);
      negativeControls.push({ engine, symptom: file === "read-service.ts" ? "wrong service implementation input" : "wrong event payload", diagnostic: Number(match[3]) });
    }
  }
  const results: Partial<Record<"harness" | "cordis", Journeys>> = {};
  for (const [engine, entry, name] of [["harness", entries.harness, "runHarness"], ["cordis", resolve(temporary, "runtime/run.ts"), "runCordis"]] as const) {
    const script = `const m = await import(${JSON.stringify(entry)}); const result = await m.${name}(); process.stdout.write(JSON.stringify({ result, runtime: { bun: Bun.version, execArgv: process.execArgv } }));`;
    const worker = resolve(temporary, `${engine}-worker.ts`); await writeFile(worker, script);
    const output: unknown = JSON.parse(await runCommand([process.execPath, worker], environment));
    assert(output && typeof output === "object" && "result" in output && "runtime" in output);
    assert.deepEqual(output.runtime, { bun: Bun.version, execArgv: [] });
    const result = output.result as Journeys;
    assert.equal(result.service, "hello:world"); assert.deepEqual(result.resource, { opened: 1, closed: 1 });
    assert.deepEqual(result.task, { finished: 1, cancelled: true, closeWaited: true }); assert.deepEqual(result.event, ["changed"]);
    assert.deepEqual(result.replacement, { before: "old", after: "new", starts: 2, cleanup: ["consumer", "provider:old"], savedEntry: engine === "harness" ? "revoked" : "new" });
    assert.deepEqual(result.inFlight, { closedBeforeGate: engine === "cordis", replacementSettledBeforeGate: engine === "cordis", bodySawClosed: engine === "cordis", savedEntryBlocked: engine === "harness", next: "new" });
    assert.deepEqual(Object.keys(result).sort(), ["event", "inFlight", "replacement", "resource", "service", "task"]);
    results[engine] = result;
  }
  const drainControl = await checkDrainControl(temporary, environment);
  assert.equal(await hashFiles(import.meta.dir, toolFiles()), toolHash, "Comparison scripts changed during the run");
  assert.equal(await hashFiles(declarations, declarationFiles), declarationHash, "Declarations changed during the run");
  assert.deepEqual(await source(), provenance, "Source, compiler manifests or dependencies changed during the run");
  const compilerVersion = (JSON.parse(await readFile(resolve(root, "node_modules/typescript/package.json"), "utf8")) as { version: string }).version;
  const declarationCompilerVersion = (JSON.parse(await readFile(resolve(directory, "node_modules/typescript/package.json"), "utf8")) as { version: string }).version;
  process.stdout.write(JSON.stringify({ runtime: { bun: Bun.version, platform: process.platform, arch: process.arch }, toolHash, provenance,
    authorCheck: { compilerVersion, strictArguments, entries: { harness: entries.harness, cordis: "generated from the native API templates" }, negativeControls },
    cordisDeclarations: { compilerVersion: declarationCompilerVersion, arguments: declarationArguments.map((value) => value === declarations ? "<temporary declarations>" : value), files: declarationFiles.length, hash: declarationHash },
    scope: { service: "Shared Result business protocol; required by Harness, voluntarily used by Cordis", task: "Cordis explicitly aborts and joins its owned Promise in its disposer; Harness uses startTask", event: "Harness admission plus explicit delivery signal; Cordis parallel awaits listeners", replacement: "Harness application setPlugins; Cordis dispose/install plus dependent Fiber.await", inFlight: "Ordinary Cordis service Promise without explicit per-call tracking; Harness managed invocation", observation: "128 microtask turns with the body gate held; bounded observation, not a proof over every scheduling interleaving", timings: "No latency, throughput, memory or boilerplate-score claim" }, drainControl, results }, null, 2) + "\n");
} finally { await rm(temporary, { recursive: true, force: true }); }
