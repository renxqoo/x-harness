import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";

const sourceRoot = resolve(import.meta.dir, "../core/src");
const glob = new Bun.Glob("**/*.ts");
let checked = 0;
for await (const name of glob.scan({ cwd: sourceRoot })) {
  const path = resolve(sourceRoot, name);
  const source = await readFile(path, "utf8");
  const scanner = createScanner(false, LanguageVariant.Standard, source);
  const production = !name.split("/").includes("__test__");
  const checkImport = (specifier: string) => {
    const target = relative(sourceRoot, resolve(path, "..", specifier));
    if (!specifier.startsWith(".") || target.startsWith("..") || target.split("/").includes("__test__")) throw new Error(`Kernel dependency violation in ${name}: ${specifier}`);
  };
  let previous = SyntaxKind.Unknown;
  let beforePrevious = SyntaxKind.Unknown;
  for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
    if (token === SyntaxKind.SingleLineCommentTrivia || token === SyntaxKind.MultiLineCommentTrivia) throw new Error(`Code comment in ${name}`);
    if (token === SyntaxKind.WhitespaceTrivia || token === SyntaxKind.NewLineTrivia) continue;
    if (production) {
      if (token === SyntaxKind.Identifier && ["Bun", "process", "require"].includes(scanner.getTokenText())) throw new Error(`Platform dependency in ${name}: ${scanner.getTokenText()}`);
      if (token === SyntaxKind.ClassKeyword) throw new Error(`Class in ${name}`);
      const imports = previous === SyntaxKind.FromKeyword || (previous === SyntaxKind.ImportKeyword && token === SyntaxKind.StringLiteral) ||
        (previous === SyntaxKind.OpenParenToken && beforePrevious === SyntaxKind.ImportKeyword);
      if (imports) {
        if (token !== SyntaxKind.StringLiteral) throw new Error(`Unresolved import in ${name}`);
        checkImport(scanner.getTokenValue());
      }
    }
    beforePrevious = previous;
    previous = token;
  }
  if (production) checked += 1;
}
process.stdout.write(`${checked} kernel source files passed dependency and code-style boundary checks\n`);
