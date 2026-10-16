import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { readData } from "../../core/src/validation";
import type { Result } from "../../core/src/index";
import type { LoaderConfig, LoaderFault, LoaderOptions, SharedModule } from "./types";
import { loaderFault } from "./loader-fault";

export async function readLoaderOptions(options: LoaderOptions): Promise<Result<LoaderConfig, LoaderFault>> {
  const read = readData(options);
  if (!read.ok || Object.keys(read.value).some((key) => !["entries", "shared", "watch", "debounceMs", "maxImports", "importTimeoutMs", "application"].includes(key))) return loaderFault("invalid-input");
  const data = read.value;
  const importTimeoutMs = data.importTimeoutMs ?? 5000;
  const debounceMs = data.debounceMs ?? 25; const maxImports = data.maxImports ?? 64;
  if (!Number.isSafeInteger(importTimeoutMs) || (importTimeoutMs as number) < 1 || (importTimeoutMs as number) > 60000 || !Number.isSafeInteger(debounceMs) || (debounceMs as number) < 0 || (debounceMs as number) > 60000 || !Number.isSafeInteger(maxImports) || (maxImports as number) < 1 || (maxImports as number) > 64 ||
      (data.watch !== undefined && typeof data.watch !== "boolean")) return loaderFault("invalid-input");
  try {
    if (!Array.isArray(data.entries) || !data.entries.length || data.entries.length > 128) return loaderFault("invalid-input");
    const entries: string[] = [];
    for (let index = 0; index < data.entries.length; index += 1) {
      const item = Object.getOwnPropertyDescriptor(data.entries, String(index));
      if (!item || !("value" in item) || typeof item.value !== "string" || !isAbsolute(item.value)) return loaderFault("invalid-input");
      const path = await realpath(item.value); if (!(await stat(path)).isFile() || entries.includes(path)) return loaderFault("invalid-input"); entries.push(path);
    }
    const sharedData = readData(data.shared ?? {}); if (!sharedData.ok || Object.keys(sharedData.value).length > 32) return loaderFault("invalid-input");
    const shared = new Map<string, SharedModule>();
    for (const [specifier, value] of Object.entries(sharedData.value)) {
      const item = readData(value);
      if (!specifier || specifier.length > 160 || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("@x-harness/") ||
          !item.ok || Object.keys(item.value).some((key) => !["path", "directory"].includes(key)) || typeof item.value.path !== "string" || typeof item.value.directory !== "string" ||
          !isAbsolute(item.value.path) || !isAbsolute(item.value.directory)) return loaderFault("invalid-input");
      const path = await realpath(item.value.path); const directory = await realpath(item.value.directory); const inside = relative(directory, path);
      if (!(await stat(path)).isFile() || !(await stat(directory)).isDirectory() || inside.startsWith("..") || isAbsolute(inside)) return loaderFault("invalid-input");
      shared.set(specifier, { path, directory });
    }
    return { ok: true, value: { entries, shared, watch: data.watch === true, debounceMs: debounceMs as number, maxImports: maxImports as number, importTimeoutMs: importTimeoutMs as number, application: data.application as LoaderConfig["application"] } };
  } catch { return loaderFault("invalid-input"); }
}
