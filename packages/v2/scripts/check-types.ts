import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const fixtures = resolve(import.meta.dir, "../core/src/contracts/__test__/type-fixtures");
const directory = await mkdtemp(resolve(tmpdir(), "kernel-types-"));
const entry = resolve(import.meta.dir, "../core/src/index.ts");
const compiler = resolve(import.meta.dir, "../../../node_modules/typescript/bin/tsc");
const imports = `import { defineService } from ${JSON.stringify(entry)};\nimport type { Context, CleanupContext, Invocation, ServiceToken, ChainToken, GuardToken, EventToken, Result, CoreFault, MethodSpec } from ${JSON.stringify(entry)};\n`;
const common = `declare const ctx: Context;\ndeclare const cleanup: CleanupContext;\ndeclare const service: ServiceToken<{ run(input: { text: string }): Promise<Result<number, { kind: "denied" }>> }>;\ndeclare const chain: ChainToken<string, number>;\ndeclare const guard: GuardToken<string>;\ndeclare const event: EventToken<string>;\n`;
let count = 0;
try {
  for (const name of (await readdir(fixtures)).filter((item) => item.endsWith(".case")).sort()) {
    const source = (await readFile(resolve(fixtures, name), "utf8")).replaceAll('"__PUBLIC_ENTRY__"', JSON.stringify(entry));
    const file = resolve(directory, `${name}.ts`);
    await writeFile(file, imports + common + source);
    const child = Bun.spawn(["bun", compiler, "--ignoreConfig", "--noEmit", "--allowImportingTsExtensions", "--strict", "--skipLibCheck", "--target", "ESNext", "--lib", "ESNext,DOM", "--module", "ESNext", "--moduleResolution", "bundler", file], { stdout: "pipe", stderr: "pipe" });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const diagnostics = [...(output + errors).matchAll(/\.case\.ts\((\d+),\d+\): error TS(\d+)/g)];
    const rejectedUsage = diagnostics.some((match) => Number(match[1]) >= 9 && ![2307, 2688, 5097].includes(Number(match[2])));
    if (code === 0 || !rejectedUsage || /error TS5097/.test(output + errors)) throw new Error(`Negative type fixture did not reject its API usage: ${name}`);
    count += 1;
  }
  const documents = [
    {
      path: "../EXAMPLES.md", count: 9,
      prefix: `import { createContext, defineService } from ${JSON.stringify(entry)};\nimport type { Context, DependencyContext, Invocation, ServiceImplementation, ServiceToken, ChainToken, GuardToken, GuardHandler, Plugin, Disposer, Result, CoreFault, LoadReport } from ${JSON.stringify(entry)};\n`,
    },
    { path: "../core/README.md", count: 14, prefix: "" },
  ];
  let examples = 0;
  for (const document of documents) {
    const source = await readFile(resolve(import.meta.dir, document.path), "utf8");
    const blocks = [...source.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]);
    if (blocks.length !== document.count) throw new Error(`Unexpected example block count: ${document.path}`);
    const example = resolve(directory, "examples.ts");
    await writeFile(example, document.prefix + blocks.join("\n").replaceAll('"@x-harness/core"', JSON.stringify(entry)));
    const child = Bun.spawn(["bun", compiler, "--ignoreConfig", "--noEmit", "--allowImportingTsExtensions", "--strict", "--noUncheckedIndexedAccess", "--skipLibCheck", "--target", "ESNext", "--lib", "ESNext,DOM", "--module", "ESNext", "--moduleResolution", "bundler", example], { stdout: "pipe", stderr: "pipe" });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Examples failed typechecking in ${document.path}: ${output}${errors}`);
    examples += blocks.length;
  }
  process.stdout.write(`${count} negative type fixtures rejected; ${examples} documentation examples passed public API typechecking\n`);
} finally { await rm(directory, { recursive: true, force: true }); }
