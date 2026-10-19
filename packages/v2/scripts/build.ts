import { resolve, relative, dirname } from "node:path";
import { rm, writeFile } from "node:fs/promises";

const root = resolve(import.meta.dir, "..");
const publicEntries = ["plugins/agent-loop/src/index", "plugins/llm/src/index", "plugins/tool-scheduler/src/index", "plugins/agent-loop/src/contracts", "plugins/llm/src/validation", "plugins/execution/src/contracts", "plugins/execution/src/index", "plugins/tools/src/planning/shared", "plugins/tools/src/index", "plugins/tool-scheduler/src/contracts", "plugins/tools/src/validation", "plugins/tools/src/contracts","plugins/session/src/contracts", "plugins/session/src/storage", "plugins/llm/src/contracts", "plugins/llm/src/provider", "plugins/llm/src/testing", "plugins/llm-http/src/index"];
const dependency = (outdir: string): Bun.BunPlugin => ({ name: "public-core", setup(build) {
  build.onResolve({ filter: /\/(shared|contracts|storage|provider|testing|validation|index)(\.ts)?$/ }, (args) => {
    if (!args.importer) return;
    const resolved = resolve(dirname(args.importer), args.path).replace(/\.ts$/, "");
    const contract = publicEntries.find((entry) => resolved === resolve(root, entry));
    if (contract) return { path: "./" + relative(resolve(root, outdir), `${resolve(root, contract)}.ts`), external: true };
  });
  build.onResolve({ filter: /(definition-data|revocation-data)(\.ts)?$/ }, (args) => {
    if (!args.importer) return;
    const path = resolve(dirname(args.importer), args.path).replace(/\.ts$/, "");
    if (["core/src/contracts/definition-data", "core/src/context/revocation-data"].some((entry) => path === resolve(root, entry))) return { path: "./" + relative(resolve(root, outdir), `${path}.ts`), external: true };
  });
  build.onResolve({ filter: /core\/src\/(index|validation)(\.ts)?$/ }, (args) => {
    if (args.importer && !args.importer.includes("/core/src/")) return { path: "./" + relative(resolve(root, outdir), resolve(root, args.path.includes("validation") ? "core/src/validation.ts" : "core/src/index.ts")), external: true };
  });
} });
for (const config of [
  { entrypoints: ["plugins/agent-loop/src/index.ts"], outdir: "plugins/agent-loop/dist", target: "browser" as const },
  { entrypoints: ["plugins/execution-process/src/index.ts"], outdir: "plugins/execution-process/dist", target: "bun" as const },
  { entrypoints: ["plugins/execution-local/src/index.ts"], outdir: "plugins/execution-local/dist", target: "bun" as const },
  { entrypoints: ["plugins/sandbox/src/index.ts","plugins/sandbox/src/sandbox-worker.ts"], outdir: "plugins/sandbox/dist", target: "bun" as const },
  { entrypoints: ["plugins/execution/src/index.ts"], outdir: "plugins/execution/dist", target: "browser" as const },
  { entrypoints: ["plugins/tool-scheduler/src/index.ts"], outdir: "plugins/tool-scheduler/dist", target: "browser" as const },
  { entrypoints: ["plugins/tools/src/index.ts"], outdir: "plugins/tools/dist", target: "browser" as const },
  { entrypoints: ["plugins/llm/src/index.ts", "plugins/llm/src/provider.ts", "plugins/llm/src/testing.ts", "plugins/llm/src/validation.ts"], outdir: "plugins/llm/dist", target: "browser" as const },
  { entrypoints: ["plugins/llm-http/src/index.ts"], outdir: "plugins/llm-http/dist", target: "browser" as const },
  { entrypoints: ["plugins/llm-openai/src/index.ts"], outdir: "plugins/llm-openai/dist", target: "browser" as const },
  { entrypoints: ["plugins/llm-anthropic/src/index.ts"], outdir: "plugins/llm-anthropic/dist", target: "browser" as const },
  { entrypoints: ["plugins/session/src/index.ts", "plugins/session/src/testing.ts"], outdir: "plugins/session/dist", target: "browser" as const },
  { entrypoints: ["plugins/session-storage-sql/src/index.ts"], outdir: "plugins/session-storage-sql/dist", target: "browser" as const },
  { entrypoints: ["plugins/session-sqlite/src/index.ts", "plugins/session-sqlite/src/sqlite-worker.ts"], naming: "[name].js", outdir: "plugins/session-sqlite/dist", target: "bun" as const },
  { entrypoints: ["plugins/session-jsonl/src/index.ts"], outdir: "plugins/session-jsonl/dist", target: "bun" as const },
  { entrypoints: ["plugins/session-postgres/src/index.ts"], outdir: "plugins/session-postgres/dist", target: "bun" as const },
  { entrypoints: ["core/src/index.ts", "core/src/validation.ts"], outdir: "core/dist", target: "browser" as const },
  { entrypoints: ["standard/src/index.ts"], outdir: "standard/dist", target: "browser" as const },
  { entrypoints: ["application/src/index.ts"], outdir: "application/dist", target: "browser" as const },
  { entrypoints: ["loader/src/index.ts"], outdir: "loader/dist", target: "bun" as const },
  { entrypoints: ["create/src/index.ts", "create/src/cli.ts"], outdir: "create/dist", target: "bun" as const },
]) {
  await rm(resolve(root, config.outdir), { recursive: true, force: true });
  const built = await Bun.build({ ...config, splitting: true, entrypoints: config.entrypoints.map((entry) => resolve(root, entry)), outdir: resolve(root, config.outdir), plugins: [dependency(config.outdir)] });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  for (const entry of publicEntries.filter((entry) => /\/(contracts|storage|validation)$/.test(entry) && dirname(entry).replace("/src", "/dist") === config.outdir)) {
    const name = entry.split("/").at(-1)!; await writeFile(resolve(root, config.outdir, `${name}.js`), `export * from ${JSON.stringify("./" + relative(resolve(root, config.outdir), resolve(root, `${entry}.ts`)))};\n`);
  }
  process.stdout.write(`${config.outdir}: ${built.outputs.map((output) => `${output.kind} ${output.size} bytes`).join(", ")}\n`);
}
