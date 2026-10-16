import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import type { Result } from "../../core/src/index";
import type { LoaderFault } from "./types";
import { loaderFault } from "./loader-fault";

export function watchDirectories(directories: readonly string[], recursive: ReadonlySet<string>, callbacks: { changed(this: void): void; failed(this: void): void }): Result<() => void, LoaderFault> {
  const watchers: FSWatcher[] = [];
  try {
    for (const directory of directories) { const watcher = watch(directory, { recursive: recursive.has(directory) }, callbacks.changed); watcher.on("error", callbacks.failed); watchers.push(watcher); }
    return { ok: true, value: () => { for (const watcher of watchers) watcher.close(); watchers.length = 0; } };
  } catch { for (const watcher of watchers) watcher.close(); return loaderFault("watch-failed"); }
}
