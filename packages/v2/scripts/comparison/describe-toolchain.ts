import assert from "node:assert/strict";
import { dirname } from "node:path";
import { hashFiles } from "./hash-files";

export async function describeToolchain(root: string, packages: readonly string[]) {
  const result: Record<string, { files: number; hash: string }> = {}; const parents = [root];
  for (const name of packages) {
    let directory: string | undefined;
    for (const parent of parents) { try { directory = dirname(Bun.resolveSync(`${name}/package.json`, parent)); break; } catch {} }
    assert(directory, `Unresolved toolchain package: ${name}`); parents.push(directory);
    const files = [...new Bun.Glob("**/*").scanSync({ cwd: directory, onlyFiles: true })].filter((file) => !file.split("/").includes("node_modules"));
    assert(files.length, `Missing toolchain package: ${name}`); result[name] = { files: files.length, hash: await hashFiles(directory, files) };
  }
  return result;
}
