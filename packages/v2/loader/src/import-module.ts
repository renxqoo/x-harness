import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePlugin } from "../../core/src/index";
import type { Plugin, Result } from "../../core/src/index";
import type { LoaderFault } from "./types";
import { loaderFault } from "./loader-fault";

import { reserveImport } from "./reserve-import";
export async function importModule(source: string, timeoutMs: number): Promise<Result<Plugin, LoaderFault>> {
  if (!reserveImport()) return loaderFault("restart-required");
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "x-harness-module-")); const path = join(directory, "plugin.mjs");
    await writeFile(path, source, { flag: "wx", mode: 0o600 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); });
    let module: unknown;
    try { module = await Promise.race([import(pathToFileURL(path).href), timeout]); }
    finally { clearTimeout(timer); }
    if (module === undefined) return loaderFault("restart-required");
    const exported: unknown = Reflect.get(module as object, "default");
    const plugin = validatePlugin(exported); if (!plugin.ok) return loaderFault("invalid-plugin");
    return plugin;
  } catch { return loaderFault("import-failed"); }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}
