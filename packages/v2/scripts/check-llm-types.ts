import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, ".."); const fixtureRoot = resolve(root, "plugins/llm/src/__test__/type-fixtures"); const directory = await mkdtemp(resolve(tmpdir(), "llm-types-"));
const core = resolve(root, "core/src/index.ts");
const prefix = `import type { LlmService, LlmMessage, ProviderEvent, LlmToolCall, LlmCitation, LlmError, LlmProviderService } from ${JSON.stringify(resolve(root, "plugins/llm/src/contracts.ts"))};\nimport { verifyLlmProvider } from ${JSON.stringify(resolve(root, "plugins/llm/src/testing.ts"))};\ndeclare const service: LlmService;\n`;

async function compile(path: string): Promise<{ code: number; output: string }> {
  const child = Bun.spawn([process.execPath, resolve(root, "../../node_modules/typescript/bin/tsc"), "--ignoreConfig", "--noEmit", "--allowImportingTsExtensions", "--strict", "--noUncheckedIndexedAccess", "--skipLibCheck", "--target", "ESNext", "--module", "ESNext", "--moduleResolution", "bundler", "--types", resolve(root, "../../node_modules/bun-types/index.d.ts"), path], { stdout: "pipe", stderr: "pipe", timeout: 30000 });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, output: output + errors };
}
try {
  let count = 0;
  for (const name of (await readdir(fixtureRoot)).filter((name) => name.endsWith(".case"))) {
    const path = resolve(directory, `${name}.ts`); await writeFile(path, prefix + await readFile(resolve(fixtureRoot, name), "utf8")); const result = await compile(path);
    const usage = [...result.output.matchAll(/\.case\.ts\((\d+),\d+\): error TS(\d+)/g)].some((match) => Number(match[1]) >= prefix.split("\n").length && ![2307, 2688, 5097].includes(Number(match[2])));
    if (!result.code || !usage) throw new Error(`LLM type fixture did not reject its API usage: ${name}`); count++;
  }
  let examples = 0;
  for (const name of ["README", "PROVIDERS"]) {
    const document = await readFile(resolve(root, `plugins/llm/${name}.md`), "utf8"); const blocks = [...document.matchAll(/```ts\n([\s\S]*?)```/g)]; if (blocks.length !== 1) throw new Error(`Expected one example in ${name}`);
    const path = resolve(directory, `${name}-example.ts`); let source = blocks[0]![1]!.replaceAll('"@x-harness/core"', JSON.stringify(core));
    for (const plugin of ["llm/provider", "llm/testing", "llm/contracts", "llm", "llm-openai", "llm-anthropic"]) source = source.replaceAll(`"@x-harness/${plugin}"`, JSON.stringify(resolve(root, plugin.startsWith("llm/") ? `plugins/llm/src/${plugin.slice(4)}.ts` : `plugins/${plugin}/src/index.ts`)));
    await writeFile(path, source); const result = await compile(path); if (result.code) throw new Error(result.output); examples++;
  }
  process.stdout.write(`${count} LLM negative type fixtures rejected; ${examples} documentation examples passed\n`);
} finally { await rm(directory, { recursive: true, force: true }); }
