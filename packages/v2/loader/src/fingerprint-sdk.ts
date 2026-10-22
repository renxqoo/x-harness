import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sdkDirectories } from "./sdk-directories";

export async function fingerprintSdk(directories: readonly string[] = sdkDirectories): Promise<string> {
  const entries = new Map<string, { readonly kind: "directory" | "file"; readonly data: Uint8Array }>(); let nodes = 0; let bytes = 0;
  const walk = async (path: string): Promise<void> => {
    if (++nodes > 2048) throw new Error("SDK source limit");
    const entry = await lstat(path); if (entry.isSymbolicLink()) throw new Error("Unsupported SDK link");
    if (entry.isDirectory()) {
      entries.set(path, { kind: "directory", data: new Uint8Array() }); const names = (await readdir(path)).filter((name) => name !== "__test__");
      if (names.length > 2048) throw new Error("SDK source limit");
      await Promise.all(names.map((name) => walk(join(path, name)))); return;
    }
    if (!entry.isFile() || entry.size > 1048576 || (bytes += entry.size) > 16777216) throw new Error("SDK source limit");
    const data = await readFile(path); if (data.length > 1048576 || (bytes += data.length - entry.size) > 16777216) throw new Error("SDK source limit");
    entries.set(path, { kind: "file", data });
  };
  await Promise.all(directories.map(walk));
  const hash = new Bun.CryptoHasher("sha256");
  for (const [path, entry] of [...entries].sort(([left], [right]) => left.localeCompare(right))) { hash.update(JSON.stringify([entry.kind, path, entry.data.length])); hash.update(entry.data); }
  return hash.digest("hex");
}
