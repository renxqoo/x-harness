import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import { scanTokens } from "./scan-tokens";
import { sdkPublicEntries, sdkBuildSharedEntries } from "../sdk/src/index";

const root = resolve(import.meta.dir, "..");
const transpiler = new Bun.Transpiler({ loader: "ts" });
let checked = 0;
const dependencies: Record<string, readonly string[]> = {
  "plugins/agent-loop": ["core", "plugins/llm", "plugins/tools", "plugins/tool-scheduler"],
  "plugins/execution-process": ["core", "plugins/execution"],
  "plugins/execution-local": ["plugins/execution-process"],
  "plugins/sandbox": ["core", "plugins/execution", "plugins/execution-process"],
  "plugins/tool-scheduler": ["core", "plugins/tools"],
  "plugins/tools": ["core", "plugins/execution"],
  "plugins/execution": ["core"],
  "plugins/llm": ["core"],
  "plugins/llm-http": ["core", "plugins/llm"],
  "plugins/llm-openai": ["core", "plugins/llm", "plugins/llm-http"],
  "plugins/llm-anthropic": ["core", "plugins/llm", "plugins/llm-http"],
  "plugins/session": ["core"],
  "plugins/session-jsonl": ["core", "plugins/session"],
  "plugins/session-storage-sql": ["core", "plugins/session"],
  "plugins/session-sqlite": ["core", "plugins/session", "plugins/session-storage-sql"],
  "plugins/session-postgres": ["core", "plugins/session", "plugins/session-storage-sql"],
  standard: ["core"],
  application: ["core"],
  loader: ["core", "application", "standard", "sdk"],
  sdk: [],
  create: ["core"],
};
const runtimeImports: Record<string, readonly string[]> = {
  "plugins/sandbox": ["@anthropic-ai/sandbox-runtime"],
  "plugins/tools": ["ajv"],
  "plugins/llm": ["ajv"],
  "plugins/session-sqlite": ["bun:sqlite"],
  "plugins/session-postgres": ["bun"],
  "plugins/session-jsonl": ["bun:ffi"],
  loader: ["acorn"],
};

for (const [name, allowed] of Object.entries(dependencies)) {
  const sourceRoot = resolve(root, name, "src");

  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot })) {
    const path = resolve(sourceRoot, file);
    const source = await readFile(path, "utf8");
    const production = !file.split("/").includes("__test__");

    for (const scanned of scanTokens(source)) {
      const token = scanned.kind;

      if (
        token === SyntaxKind.SingleLineCommentTrivia ||
        token === SyntaxKind.MultiLineCommentTrivia
      )
        throw new Error(`Code comment in ${name}/${file}`);

      if (production && token === SyntaxKind.ClassKeyword)
        throw new Error(`Class in ${name}/${file}`);

      if (
        production &&
        [
          "plugins/agent-loop",
          "plugins/tool-scheduler",
          "plugins/tools",
          "standard",
          "application",
          "plugins/session",
          "plugins/session-storage-sql",
          "plugins/llm",
          "plugins/llm-http",
          "plugins/llm-openai",
          "plugins/llm-anthropic",
        ].includes(name) &&
        token === SyntaxKind.Identifier &&
        ["Bun", "process", "require"].includes(scanned.text)
      )
        throw new Error(`Platform dependency in ${name}/${file}`);
    }

    if (!production) continue;

    for (const entry of transpiler.scan(source).imports) {
      if (!entry.path.startsWith(".")) {
        if (
          !runtimeImports[name]?.includes(entry.path) &&
          (![
            "loader",
            "create",
            "plugins/session-sqlite",
            "plugins/session-postgres",
            "plugins/session-jsonl",
            "plugins/execution-process",
            "plugins/sandbox",
          ].includes(name) ||
            !isBuiltin(entry.path))
        )
          throw new Error(`External dependency in ${name}/${file}: ${entry.path}`);

        continue;
      }

      const target = resolve(dirname(path), entry.path).replace(/\.ts$/, "");
      const own = relative(sourceRoot, target);

      if (!own.startsWith("..") && !own.split("/").includes("__test__")) continue;

      if (
        !allowed.some(
          (dependency) =>
            target === resolve(root, dependency, "src/index") ||
            (dependency === "core" && target === resolve(root, dependency, "src/validation")) ||
            (dependency === "plugins/tools" &&
              target === resolve(root, dependency, "src/validation")) ||
            (dependency === "plugins/session" &&
              ["contracts", "storage"].some(
                (entry) => target === resolve(root, dependency, `src/${entry}`),
              )) ||
            (dependency === "plugins/llm" &&
              ["contracts", "provider", "testing", "validation"].some(
                (entry) => target === resolve(root, dependency, `src/${entry}`),
              )),
        )
      )
        throw new Error(`Private dependency in ${name}/${file}: ${entry.path}`);
    }

    checked += 1;
  }
}

process.stdout.write(
  `${checked} platform source files passed public-entry, platform and code-style boundary checks\n`,
);

const declared = new Map(sdkPublicEntries.map((entry) => [entry.specifier, entry.source]));

if (declared.size !== sdkPublicEntries.length) throw new Error("Duplicate SDK public entry");

const exported = new Map<string, string>();

for (const pattern of ["*/package.json", "plugins/*/package.json"])
  for await (const file of new Bun.Glob(pattern).scan({ cwd: root })) {
    const manifest = JSON.parse(await readFile(resolve(root, file), "utf8")) as {
      name: string;
      exports: Record<string, string>;
    };

    for (const [name, source] of Object.entries(manifest.exports))
      exported.set(
        manifest.name + (name === "." ? "" : name.slice(1)),
        relative(root, resolve(root, dirname(file), source)),
      );
  }

if (
  JSON.stringify([...declared].sort(([left], [right]) => left.localeCompare(right))) !==
  JSON.stringify([...exported].sort(([left], [right]) => left.localeCompare(right)))
)
  throw new Error("SDK public entries differ from package exports");

const configuration = JSON.parse(await readFile(resolve(root, "tsconfig.json"), "utf8")) as {
  compilerOptions: { paths: Record<string, readonly string[]> };
};

for (const [specifier, source] of declared) {
  const paths = configuration.compilerOptions.paths[specifier];

  if (!paths || paths.length !== 1 || resolve(root, paths[0]!) !== resolve(root, source))
    throw new Error("SDK public entry differs from TypeScript path");
}

for (const specifier of Object.keys(configuration.compilerOptions.paths))
  if (specifier.startsWith("@x-harness/") && !declared.has(specifier))
    throw new Error("Undeclared SDK TypeScript path");

for (const entry of sdkBuildSharedEntries) {
  if (sdkPublicEntries.some((item) => item.source === entry))
    throw new Error("SDK internal identity is a public entry");

  await readFile(resolve(root, entry));
}

process.stdout.write(
  `${declared.size} SDK public entries match package exports; ${sdkBuildSharedEntries.length} internal identity entries verified\n`,
);
