import { resolve, relative, dirname } from "node:path";
import { rm } from "node:fs/promises";

const root = resolve(import.meta.dir, "..");
const dependency = (outdir: string): Bun.BunPlugin => ({ name: "public-core", setup(build) {
  build.onResolve({ filter: /\/(contracts|storage)(\.ts)?$/ }, (args) => {
    const contract = resolve(root, args.path.replace(/\.ts$/, "").endsWith("storage") ? "plugins/session/src/storage" : "plugins/session/src/contracts");
    if (args.importer && resolve(dirname(args.importer), args.path).replace(/\.ts$/, "") === contract) return { path: relative(resolve(root, outdir), `${contract}.ts`), external: true };
  });
  build.onResolve({ filter: /core\/src\/(index|validation)(\.ts)?$/ }, (args) => {
    if (args.importer && !args.importer.includes("/core/src/")) return { path: relative(resolve(root, outdir), resolve(root, args.path.includes("validation") ? "core/src/validation.ts" : "core/src/index.ts")), external: true };
  });
} });
for (const config of [
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
  const built = await Bun.build({ ...config, entrypoints: config.entrypoints.map((entry) => resolve(root, entry)), outdir: resolve(root, config.outdir), plugins: [dependency(config.outdir)] });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  process.stdout.write(`${config.outdir}: ${built.outputs.map((output) => `${output.kind} ${output.size} bytes`).join(", ")}\n`);
}
