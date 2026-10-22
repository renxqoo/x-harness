import { applyMutation } from "./mutations/apply-mutation";
import { cp, mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
const root = resolve(import.meta.dir, "..");
const cases = [
  {
    name: "missing schema validation",
    file: "execution/run-tool.ts",
    before: 'if(!inputSchema(parsed.value))return fail("invalid-input");',
    after: 'if(false)return fail("invalid-input");',
    extra: [
      {
        file: "planning/prepare-tool.ts",
        before: 'if(!entry.compiled.input(request.input))return fail("invalid-input");',
        after: 'if(false)return fail("invalid-input");',
      },
    ],
    test: "lifecycle",
    pattern: "schema rejects invalid input",
  },
  {
    name: "authorization bypass",
    file: "planning/prepare-tool.ts",
    before: 'if((allowed.value as {kind:string}).kind!=="allow")return fail("access-denied");',
    after: 'if(false)return fail("access-denied");',
    extra: [
      {
        file: "planning/check-permission.ts",
        before: 'if((allowed.value as {kind:string}).kind!=="allow")',
        after: "if(false)",
      },
    ],
    test: "dependencies",
    pattern: "deny wins",
  },
  {
    name: "instance budget ignored",
    file: "planning/run-prepared.ts",
    before: "Math.min(n,state.entry.limits[key as keyof typeof state.entry.limits])",
    after: "state.entry.limits[key as keyof typeof state.entry.limits]",
    test: "progress",
    pattern: "instance progress limits",
  },
  {
    name: "lost root cancellation",
    file: "../../../core/src/context/create-invocation.ts",
    before: "work.fail(kernel.fault(reason, work.executor));",
    after: "void reason;",
    test: "concurrency",
    pattern: "explicit request abort returns",
  },
  {
    name: "progress receipt waits for actual drain",
    file: "execution/create-progress.ts",
    before: "}else await done;",
    after: "}await done;",
    test: "progress",
    pattern: "consumer timeout reaches the author",
  },
  {
    name: "same-name replacement steals stale ticket",
    file: "create-tool-plugin.ts",
    before: "request.ownerSignal!==ctx.signal||request.name!==entry.tool.name",
    expectedMatches: 2,
    after: "request.name!==entry.tool.name",
    test: "identity",
    pattern: "an unadvertised same-name handler",
  },
  {
    name: "ignored consumer failure",
    file: "execution/run-tool.ts",
    before: "if(!delivered.ok)return delivered;",
    after: "if(false)return delivered;",
    test: "progress",
    pattern: "ignored progress consumer failure",
  },
  {
    name: "retained consumer callback",
    file: "execution/create-progress.ts",
    before: "cell.current=undefined;return result;},close(){cell.current=undefined;}",
    after: "return result;},close(){}",
    test: "progress-retention",
    pattern: "retained closed progress",
  },
  {
    name: "schema keyword smuggling",
    file: "schema/read-schema.ts",
    before: 'if(typeof value!=="boolean")return false;',
    after: "if(false)return false;",
    test: "schema-data",
    pattern: "additionalProperties cannot smuggle",
  },
  {
    name: "secret error echo",
    file: "domain/read-error.ts",
    before: "read.message!==read.code",
    after: 'typeof read.message!=="string"',
    test: "schema-data",
    pattern: "thrown secrets",
  },
  {
    name: "capacity released before actual completion",
    file: "create-tools-plugin.ts",
    before: "await task.value.finished;if(handle)",
    after: "if(handle)",
    test: "concurrency",
    pattern: "global capacity remains occupied",
  },
  {
    name: "bare guard allow bypasses controlled grants",
    file: "planning/prepare-tool.ts",
    before: "||!permissions.length",
    after: "",
    test: "public-permission",
    pattern: "a bare allow cannot authorize",
  },
  {
    name: "late grant remains open",
    file: "planning/create-authorization.ts",
    before: "close(){cell.current=undefined;",
    after: "close(){",
    test: "public-permission",
    pattern: "saved grant callback is closed",
  },
  {
    name: "revoked plan retains later signal listeners",
    file: "planning/prepare-tool.ts",
    before: '=>{if(state.phase==="closed")return;const abort=',
    after: "=>{const abort=",
    test: "public-extension-lifetime",
    pattern: "saved grant and catalog",
  },
  {
    name: "ordinary tool capacity released before exit",
    file: "planning/run-prepared.ts",
    before: "if(task.ok)await task.value.finished;",
    after: "",
    test: "public-contribution",
    pattern: "retain their concurrency slot",
  },
  {
    name: "fresh catalog identity bypasses capacity",
    file: "contributions/read-contribution.ts",
    before: "const previous=registered.get(described.value.tool.name);",
    after: "const previous=undefined as ReturnType<typeof registered.get>;",
    test: "public-contribution-identity",
    pattern: "fresh catalog objects keep one installation",
  },
  {
    name: "Unicode signature order depends on insertion",
    file: "contributions/describe-contribution.ts",
    before: "{if(a<b)return -1;return a>b?1:0;}",
    after: "{return a.localeCompare(b);}",
    test: "public-contribution-identity",
    pattern: "equivalent Unicode schema keys",
  },
];
const directory = await mkdtemp(resolve(tmpdir(), "tools-mutations-"));
const target = resolve(directory, "packages/v2");
const reports: { name: string; detected: boolean; code: number; evidence: string }[] = [];

async function run(test: string, pattern?: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(root, "../../node_modules/vitest/vitest.mjs"),
      "run",
      test,
      ...(pattern ? ["-t", pattern] : []),
    ],
    { cwd: target, stdout: "pipe", stderr: "pipe", timeout: 20000 },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: stdout + stderr };
}

try {
  await mkdir(resolve(directory, "packages"));
  await cp(root, target, {
    recursive: true,
    filter: (path) =>
      !["node_modules", "dist", "coverage", ".git", ".vitest"].includes(path.split("/").at(-1)!),
  });
  await symlink(resolve(root, "../../node_modules"), resolve(directory, "node_modules"));
  await symlink(resolve(root, "node_modules"), resolve(target, "node_modules"));
  const baseline = await run("plugins/tools/src/__test__");
  const count = Number(/Tests\s+(\d+) passed/.exec(baseline.output)?.[1] ?? 0);

  if (baseline.code || !count) throw new Error("Mutation baseline failed: " + baseline.output);

  for (const mutation of cases) {
    const edits = [mutation, ...("extra" in mutation ? (mutation.extra ?? []) : [])];
    const originals: { path: string; source: string }[] = [];

    for (const edit of edits) {
      const path = resolve(target, "plugins/tools/src", edit.file),
        source = await readFile(path, "utf8");
      originals.push({ path, source });
      await writeFile(path, applyMutation(source, edit));
    }

    try {
      const result = await run(
        `plugins/tools/src/__test__/${mutation.test}.test.ts`,
        mutation.pattern,
      );
      const evidence =
        result.output.split("\n").find((line) => line.includes("AssertionError:")) ??
        result.output.slice(0, 1000);
      const detected =
        result.code !== 0 &&
        result.output.includes("AssertionError:") &&
        !result.output.includes("Test timed out") &&
        !result.output.includes("Failed to resolve");
      reports.push({ name: mutation.name, detected, code: result.code, evidence });
      process.stdout.write(`${detected ? "detected" : "SURVIVED"}: ${mutation.name}\n`);
    } finally {
      for (const { path, source } of originals) await writeFile(path, source);
    }
  }

  await writeFile(
    resolve(root, "plugins/tools/reviews/mutations.json"),
    JSON.stringify(
      {
        command: "bun run test:tools:mutations",
        runtime: Bun.version,
        baselineCases: count,
        reports,
      },
      null,
      2,
    ) + "\n",
  );

  if (reports.some((r) => !r.detected))
    throw new Error("Mutation survived or was not rejected by a behavioral assertion");
} finally {
  await rm(directory, { recursive: true, force: true });
}
