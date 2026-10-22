import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function hashFiles(directory: string, files: readonly string[]) {
  const hash = createHash("sha256");

  for (const file of [...files].sort()) {
    hash.update(file + "\0");
    hash.update(await readFile(resolve(directory, file)));
    hash.update("\0");
  }

  return hash.digest("hex");
}
