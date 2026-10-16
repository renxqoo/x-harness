import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import { scanTokens } from "./scan-tokens";

const root = resolve(import.meta.dir, ".."); const transpiler = new Bun.Transpiler({ loader: "ts" }); let checked = 0;
const dependencies: Record<string, readonly string[]> = { "plugins/session": ["core"], "plugins/session-jsonl": ["core", "plugins/session"], "plugins/session-storage-sql": ["core", "plugins/session"], "plugins/session-sqlite": ["core", "plugins/session", "plugins/session-storage-sql"], "plugins/session-postgres": ["core", "plugins/session", "plugins/session-storage-sql"], standard: ["core"], application: ["core"], loader: ["core", "application", "standard"], create: ["core"] };
const runtimeImports: Record<string, readonly string[]> = { "plugins/session-sqlite": ["bun:sqlite"], "plugins/session-postgres": ["bun"], "plugins/session-jsonl": ["bun:ffi"], loader: ["acorn"] };
for (const [name, allowed] of Object.entries(dependencies)) {
  const sourceRoot = resolve(root, name, "src");
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot })) {
    const path = resolve(sourceRoot, file); const source = await readFile(path, "utf8"); const production = !file.split("/").includes("__test__");
    for (const scanned of scanTokens(source)) {
      const token = scanned.kind;
      if (token === SyntaxKind.SingleLineCommentTrivia || token === SyntaxKind.MultiLineCommentTrivia) throw new Error(`Code comment in ${name}/${file}`);
      if (production && token === SyntaxKind.ClassKeyword) throw new Error(`Class in ${name}/${file}`);
      if (production && ["standard", "application", "plugins/session", "plugins/session-storage-sql"].includes(name) && token === SyntaxKind.Identifier && ["Bun", "process", "require"].includes(scanned.text)) throw new Error(`Platform dependency in ${name}/${file}`);
    }
    if (!production) continue;
    for (const entry of transpiler.scan(source).imports) {
      if (!entry.path.startsWith(".")) {
        if (!["loader", "create", "plugins/session-sqlite", "plugins/session-postgres", "plugins/session-jsonl"].includes(name) || (!isBuiltin(entry.path) && !runtimeImports[name]?.includes(entry.path))) throw new Error(`External dependency in ${name}/${file}: ${entry.path}`);
        continue;
      }
      const target = resolve(dirname(path), entry.path).replace(/\.ts$/, ""); const own = relative(sourceRoot, target);
      if (!own.startsWith("..") && !own.split("/").includes("__test__")) continue;
      if (!allowed.some((dependency) => target === resolve(root, dependency, "src/index") || (dependency === "core" && target === resolve(root, dependency, "src/validation")) || (dependency === "plugins/session" && ["contracts", "storage"].some((entry) => target === resolve(root, dependency, `src/${entry}`))))) throw new Error(`Private dependency in ${name}/${file}: ${entry.path}`);
    }
    checked += 1;
  }
}
process.stdout.write(`${checked} platform source files passed public-entry, platform and code-style boundary checks\n`);
