import { readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { SharedModule } from "./types";

export async function fingerprintShared(
  shared: ReadonlyMap<string, SharedModule>,
): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  let count = 0;
  let bytes = 0;

  const walk = async (path: string): Promise<void> => {
    if (++count > 1024) throw new Error("Shared directory limit");

    const entry = await lstat(path);

    if (entry.isSymbolicLink()) throw new Error("Unsupported shared link");

    if (entry.isDirectory()) {
      hash.update(JSON.stringify(["directory", path]));
      const names = await readdir(path);

      if (names.length > 1024) throw new Error("Shared directory limit");

      for (const name of names.sort()) await walk(join(path, name));

      return;
    }

    if (!entry.isFile() || entry.size > 1048576 || (bytes += entry.size) > 16777216)
      throw new Error("Shared directory limit");

    const data = await readFile(path);

    if (data.length > 1048576 || (bytes += data.length - entry.size) > 16777216)
      throw new Error("Shared directory limit");

    hash.update(JSON.stringify(["file", path, data.length]));
    hash.update(data);
  };

  for (const directory of [...new Set([...shared.values()].map((item) => item.directory))].sort())
    await walk(directory);

  return hash.digest("hex");
}
