import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";

export async function describeSource(
  source: string,
  config: { root: string; locks: readonly string[]; paths: readonly string[] },
) {
  const paths = [...new Bun.Glob("**/*.ts").scanSync({ cwd: source })]
    .filter((file) => !file.split("/").includes("__test__"))
    .sort();
  assert(paths.length);
  const hash = createHash("sha256");
  const imports = new Set<string>();
  const transpiler = new Bun.Transpiler({ loader: "ts" });

  for (const path of paths) {
    const content = await readFile(resolve(source, path), "utf8");
    hash.update(path + "\0" + content + "\0");

    for (const entry of transpiler.scan(content).imports)
      if (!entry.path.startsWith(".") && !isBuiltin(entry.path)) imports.add(entry.path);
  }

  const dependencies: {
    specifier: string;
    entry: string;
    entryHash: string;
    manifestPath: string;
    manifestHash: string;
    version: unknown;
  }[] = [];

  for (const specifier of [...imports].sort()) {
    const entry = await realpath(Bun.resolveSync(specifier, source));
    let directory = dirname(entry);

    while (!(await Bun.file(resolve(directory, "package.json")).exists())) {
      const parent = dirname(directory);
      assert(parent !== directory);
      directory = parent;
    }

    const manifestPath = resolve(directory, "package.json");
    const manifest = await readFile(manifestPath, "utf8");
    const content = await readFile(entry, "utf8");
    const runtimeImports = new Bun.Transpiler({ loader: "js" }).scan(content).imports;
    assert(
      runtimeImports.every((dependency) => isBuiltin(dependency.path)),
      "Unbundled external dependency needs transitive provenance",
    );
    dependencies.push({
      specifier,
      entry,
      entryHash: createHash("sha256").update(content).digest("hex"),
      manifestPath,
      manifestHash: createHash("sha256").update(manifest).digest("hex"),
      version: (JSON.parse(manifest) as { version?: unknown }).version,
    });
  }

  const manifests: Record<string, string | null> = {};

  for (const file of config.locks)
    manifests[file] = (await Bun.file(resolve(config.root, file)).exists())
      ? createHash("sha256")
          .update(await readFile(resolve(config.root, file)))
          .digest("hex")
      : null;

  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", "-C", config.root, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return status === 0 ? stdout.trim() : null;
  };

  return {
    source,
    sourceHash: hash.digest("hex"),
    files: paths.length,
    dependencies,
    manifests,
    git: {
      head: await git(["rev-parse", "HEAD"]),
      status: await git(["status", "--porcelain", "--", ...config.paths]),
    },
  };
}
