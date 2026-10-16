import { realpath } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { Result } from "../../core/src/index";
import { checkBundle } from "./check-bundle";
import { loaderFault } from "./loader-fault";
import type { LoaderConfig, LoaderFault } from "./types";

const publicModules = new Map([
  ["@x-harness/core", import.meta.resolve("../../core/src/index.ts")],
  ["@x-harness/core/validation", import.meta.resolve("../../core/src/validation.ts")],
  ["@x-harness/standard", import.meta.resolve("../../standard/src/index.ts")],
]);

export async function buildModule(entry: string, config: LoaderConfig, discovered: (directory: string) => void = () => {}): Promise<Result<{ source: string; hash: string; directories: readonly string[] }, LoaderFault>> {
  const allowed = new Set<string>();
  const shared = new Map([...config.shared].map(([name, item]) => [name, pathToFileURL(item.path).href]));
  const plugin: Bun.BunPlugin = { name: "stable-contracts", setup(builder) {
    builder.onResolve({ filter: /.*/ }, async (args) => {
      if (!args.importer) return;
      const fixed = publicModules.get(args.path) ?? shared.get(args.path);
      if (fixed) { allowed.add(fixed); return { path: fixed, external: true }; }
      if (isBuiltin(args.path) || args.path.startsWith("bun:")) { allowed.add(args.path); return { path: args.path, external: true }; }
      let resolved: string;
      try { resolved = await realpath(Bun.resolveSync(args.path, args.resolveDir || dirname(args.importer))); }
      catch (error) {
        if (args.path.startsWith(".") || isAbsolute(args.path)) {
          let directory = dirname(resolve(args.resolveDir || dirname(args.importer), args.path));
          while (true) { try { discovered(await realpath(directory)); break; } catch { const parent = dirname(directory); if (parent === directory) break; directory = parent; } }
        }
        throw error;
      }
      const url = pathToFileURL(resolved).href;
      if ([...publicModules.values()].some((item) => fileURLToPath(item) === resolved) || [...config.shared.values()].some((item) => {
        const path = relative(item.directory, resolved); return !path.startsWith("..") && !isAbsolute(path);
      })) { allowed.add(url); return { path: url, external: true }; }
      discovered(dirname(resolved)); return { path: resolved };
    });
  } };
  try {
    const built = await Bun.build({ entrypoints: [entry], target: "bun", format: "esm", splitting: false, sourcemap: "none", metafile: true, plugins: [plugin], throw: false });
    if (!built.success || built.outputs.length !== 1 || built.outputs[0]!.kind !== "entry-point" || built.outputs[0]!.size > 1048576) return loaderFault("build-failed");
    const source = await built.outputs[0]!.text(); if (!checkBundle(source, allowed)) return loaderFault("build-failed");
    const directories = [...new Set(Object.keys(built.metafile!.inputs).map((path) => dirname(isAbsolute(path) ? path : resolve(path))))];
    if (directories.length > 512) return loaderFault("build-failed");
    return { ok: true, value: { source, hash: new Bun.CryptoHasher("sha256").update(source).digest("hex"), directories } };
  } catch { return loaderFault("build-failed"); }
}
