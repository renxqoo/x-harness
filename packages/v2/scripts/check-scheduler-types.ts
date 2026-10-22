import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const directory = await mkdtemp(resolve(tmpdir(), "scheduler-types-"));
const core = resolve(root, "core/src/index.ts"),
  entry = resolve(root, "plugins/tool-scheduler/src/index.ts");
const toolsEntry = resolve(root, "plugins/tools/src/index.ts");
const prefix = `import {createToolSchedulerPlugin} from ${JSON.stringify(entry)};\nimport type {ToolSchedulerService,SchedulerError} from ${JSON.stringify(entry)};\ndeclare const service:ToolSchedulerService;\n`;

async function compile(path: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(root, "../../node_modules/typescript/bin/tsc"),
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--noUncheckedIndexedAccess",
      "--allowImportingTsExtensions",
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
    { stdout: "pipe", stderr: "pipe", timeout: 30000 },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: stdout + stderr };
}

try {
  let count = 0;
  const fixtureRoot = resolve(root, "plugins/tool-scheduler/src/__test__/type-fixtures");

  for (const name of (await readdir(fixtureRoot)).filter((n) => n.endsWith(".case"))) {
    const path = resolve(directory, name + ".ts");
    await writeFile(path, prefix + (await readFile(resolve(fixtureRoot, name), "utf8")));
    const result = await compile(path);
    const rejected = [...result.output.matchAll(/\.case\.ts\((\d+),\d+\): error TS(\d+)/g)].some(
      (m) =>
        Number(m[1]) >= prefix.split("\n").length && ![2307, 2688, 5097].includes(Number(m[2])),
    );

    if (!result.code || !rejected)
      throw new Error("Type fixture failed to reject API usage: " + name);

    count++;
  }

  let examples = 0;

  for (const name of ["README", "POLICY"]) {
    const doc = await readFile(resolve(root, `plugins/tool-scheduler/${name}.md`), "utf8");
    const blocks = [...doc.matchAll(/```ts\n([\s\S]*?)```/g)];

    if (blocks.length !== 1) throw new Error("Missing complete documentation example");

    const path = resolve(directory, name + ".ts");
    await writeFile(
      path,
      blocks[0]![1]!
        .replaceAll('"@x-harness/core"', JSON.stringify(core))
        .replaceAll('"@x-harness/tools"', JSON.stringify(toolsEntry))
        .replaceAll('"@x-harness/tool-scheduler"', JSON.stringify(entry)),
    );
    const result = await compile(path);

    if (result.code) throw new Error(result.output);

    examples++;
  }

  process.stdout.write(
    `${count} scheduler negative type fixtures rejected; ${examples} documentation examples passed\n`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
