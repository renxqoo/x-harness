import type { WatchTarget } from "./watch-types";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";

export async function normalizeWatchDirectories(
  directories: Set<string>,
  roots: ReadonlySet<string>,
): Promise<readonly WatchTarget[]> {
  const existing = new Map<string, string>();
  const retained = new Set<string>();

  for (const path of new Set([...directories, ...roots])) {
    let directory = path;

    if (roots.has(path)) retained.add(path);

    while (true) {
      try {
        const identity = await stat(directory);

        if (!identity.isDirectory())
          throw Object.assign(new Error("Watch target is not a directory"), { code: "ENOTDIR" });

        existing.set(directory, `${identity.dev}:${identity.ino}`);

        if (directory === path) retained.add(path);

        break;
      } catch (error) {
        const code = (error as { code?: string }).code;

        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;

        const parent = dirname(directory);

        if (!roots.has(path) || parent === directory) break;

        directory = parent;
      }
    }
  }

  directories.clear();

  for (const directory of retained) directories.add(directory);

  const ordered = [...existing].sort(([left], [right]) => left.localeCompare(right));
  return ordered.map(([path, identity]) =>
    Object.freeze({ path, identity, recursive: roots.has(path) }),
  );
}
