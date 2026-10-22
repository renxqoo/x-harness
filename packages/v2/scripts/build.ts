import { resolve, relative, dirname } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { sdkPublicEntries, sdkBuildSharedEntries } from "../sdk/src/index";

const root = resolve(import.meta.dir, "..");
const publicEntries = sdkPublicEntries.map((entry) => entry.source);
const sharedEntries = [...publicEntries, ...sdkBuildSharedEntries];
const dependency = (outdir: string): Bun.BunPlugin => ({ name: "stable-sdk", setup(build) {
  build.onResolve({ filter: /.*/ }, (args) => {
    if (!args.importer) return;
    const resolved = resolve(dirname(args.importer), args.path).replace(/\.ts$/, "");
    const entry = sharedEntries.find((source) => resolved === resolve(root, source).replace(/\.ts$/, ""));
    if (entry) return { path: "./" + relative(resolve(root, outdir), resolve(root, entry)), external: true };
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
  for (const entry of publicEntries.filter((source) => dirname(source).replace("/src", "/dist") === config.outdir && !config.entrypoints.includes(source))) {
    const name = entry.split("/").at(-1)!.replace(/\.ts$/, ".js"); await writeFile(resolve(root, config.outdir, name), `export * from ${JSON.stringify("./" + relative(resolve(root, config.outdir), resolve(root, entry)))};\n`);
  }
  process.stdout.write(`${config.outdir}: ${built.outputs.map((output) => `${output.kind} ${output.size} bytes`).join(", ")}\n`);
}
