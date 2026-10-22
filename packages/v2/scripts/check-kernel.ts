import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import { scanTokens } from "./scan-tokens";

const sourceRoot = resolve(import.meta.dir, "../core/src");
const glob = new Bun.Glob("**/*.ts");
let checked = 0;
const dependencies = new Map<string, string[]>();
const transpiler = new Bun.Transpiler({ loader: "ts" });

for await (const name of glob.scan({ cwd: sourceRoot })) {
  const path = resolve(sourceRoot, name);
  const source = await readFile(path, "utf8");
  const production = !name.split("/").includes("__test__");

  const checkImport = (specifier: string) => {
    const target = relative(sourceRoot, resolve(path, "..", specifier));

    if (
      !specifier.startsWith(".") ||
      target.startsWith("..") ||
      target.split("/").includes("__test__")
    )
      throw new Error(`Kernel dependency violation in ${name}: ${specifier}`);
  };

  let previous = SyntaxKind.Unknown;
  let beforePrevious = SyntaxKind.Unknown;

  for (const scanned of scanTokens(source)) {
    const token = scanned.kind;

    if (token === SyntaxKind.SingleLineCommentTrivia || token === SyntaxKind.MultiLineCommentTrivia)
      throw new Error(`Code comment in ${name}`);

    if (token === SyntaxKind.WhitespaceTrivia || token === SyntaxKind.NewLineTrivia) continue;

    if (production) {
      if (token === SyntaxKind.Identifier && ["Bun", "process", "require"].includes(scanned.text))
        throw new Error(`Platform dependency in ${name}: ${scanned.text}`);

      if (token === SyntaxKind.ClassKeyword) throw new Error(`Class in ${name}`);

      const imports =
        (previous === SyntaxKind.FromKeyword && beforePrevious !== SyntaxKind.DotToken) ||
        (previous === SyntaxKind.ImportKeyword && token === SyntaxKind.StringLiteral) ||
        (previous === SyntaxKind.OpenParenToken && beforePrevious === SyntaxKind.ImportKeyword);

      if (imports) {
        if (token !== SyntaxKind.StringLiteral) throw new Error(`Unresolved import in ${name}`);

        checkImport(scanned.value!);
      }
    }

    beforePrevious = previous;
    previous = token;
  }

  if (production) {
    const imports = transpiler
      .scan(source)
      .imports.map((entry) => relative(sourceRoot, resolve(path, "..", entry.path + ".ts")));

    for (const imported of imports) {
      if (name.startsWith("contracts/") && !imported.startsWith("contracts/"))
        throw new Error(`Contract dependency violation in ${name}: ${imported}`);

      if (name !== "index.ts" && !name.startsWith("context/") && imported.startsWith("context/"))
        throw new Error(`Context factory dependency violation in ${name}: ${imported}`);

      const layers: Record<string, readonly string[]> = {
        foundation: ["foundation/", "contracts/"],
        registry: ["registry/", "foundation/", "contracts/"],
        execution: ["execution/", "foundation/", "contracts/"],
        lifetime: ["lifetime/", "execution/", "foundation/", "contracts/"],
        assembly: ["assembly/", "lifetime/", "execution/", "foundation/", "contracts/"],
      };
      const allowed = layers[name.split("/")[0]!];

      if (allowed && !allowed.some((layer) => imported.startsWith(layer)))
        throw new Error(`Kernel layer dependency violation in ${name}: ${imported}`);
    }

    dependencies.set(name, imports);
    checked += 1;
  }
}

const completed = new Set<string>();
const stack: string[] = [];

const visit = (name: string) => {
  if (stack.includes(name))
    throw new Error(
      `Kernel runtime dependency cycle: ${[...stack.slice(stack.indexOf(name)), name].join(" -> ")}`,
    );

  if (completed.has(name)) return;

  stack.push(name);

  for (const imported of dependencies.get(name) ?? []) visit(imported);

  stack.pop();
  completed.add(name);
};

for (const name of dependencies.keys()) visit(name);

process.stdout.write(
  `${checked} kernel source files passed dependency, acyclic runtime and code-style boundary checks\n`,
);
