import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const fixtureRoot = resolve(root, "plugins/session/src/__test__/type-fixtures");
const directory = await mkdtemp(resolve(tmpdir(), "session-types-"));
const entry = resolve(root, "plugins/session/src/index.ts");
const core = resolve(root, "core/src/index.ts");
const prefix = `import { createSessionPlugin } from ${JSON.stringify(entry)};\nimport type { SessionService } from ${JSON.stringify(entry)};\ndeclare const service: SessionService;\n`;

async function compile(path: string): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(root, "../../node_modules/typescript/bin/tsc"),
      "--ignoreConfig",
      "--noEmit",
      "--allowImportingTsExtensions",
      "--strict",
      "--noUncheckedIndexedAccess",
      "--skipLibCheck",
      "--target",
      "ESNext",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--types",
      resolve(root, "../../node_modules/bun-types/index.d.ts"),
      path,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: output + errors };
}

try {
  let count = 0;

  for (const name of (await readdir(fixtureRoot)).filter((name) => name.endsWith(".case"))) {
    const path = resolve(directory, `${name}.ts`);
    await writeFile(path, prefix + (await readFile(resolve(fixtureRoot, name), "utf8")));
    const result = await compile(path);
    const usage = [...result.output.matchAll(/\.case\.ts\((\d+),\d+\): error TS(\d+)/g)].some(
      (match) => Number(match[1]) >= 4 && ![2307, 2688, 5097].includes(Number(match[2])),
    );

    if (!result.code || !usage)
      throw new Error(`Session type fixture did not reject its API usage: ${name}`);

    count++;
  }

  let examples = 0;

  for (const name of ["session", "session-jsonl"]) {
    const document = await readFile(resolve(root, `plugins/${name}/README.md`), "utf8");
    const blocks = [...document.matchAll(/```ts\n([\s\S]*?)```/g)];

    if (blocks.length !== 1) throw new Error(`Expected one example in ${name}`);

    const path = resolve(directory, `${name}-example.ts`);
    let source = blocks[0]![1]!
      .replaceAll('"@x-harness/core"', JSON.stringify(core))
      .replaceAll('"@x-harness/session"', JSON.stringify(entry));

    for (const backend of ["session-sqlite", "session-jsonl"])
      source = source.replaceAll(
        `"@x-harness/${backend}"`,
        JSON.stringify(resolve(root, `plugins/${backend}/src/index.ts`)),
      );

    await writeFile(path, source);
    const result = await compile(path);

    if (result.code) throw new Error(result.output);

    examples++;
  }

  process.stdout.write(
    `${count} session negative type fixtures rejected; ${examples} documentation examples passed\n`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
