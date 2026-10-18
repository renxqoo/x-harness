import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import type { OpenDirectoryWatch } from "./watch-types";
import { loaderFault } from "./loader-fault";
export const openDirectoryWatch: OpenDirectoryWatch = (target, callbacks) => {
  const cell: { current?: typeof callbacks } = { current: callbacks };
  let watcher: FSWatcher | undefined;
  const close = () => { cell.current = undefined; watcher?.close(); watcher = undefined; };
  try {
    watcher = watch(target.path, { recursive: target.recursive }, () => cell.current?.changed());
    watcher.on("error", () => { const failed = cell.current?.failed; close(); failed?.(); });
    return { ok: true, value: close };
  } catch { close(); return loaderFault("watch-failed"); }
};
