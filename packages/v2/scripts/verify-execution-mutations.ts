import { applyMutation } from "./mutations/apply-mutation";
import { cp, mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
const root = resolve(import.meta.dir, "..");
const cases = [
  {
    name: "directory cleanup omitted",
    file: "plugins/sandbox/src/check-filesystem-roots.ts",
    before: "finally{await directory.close();}",
    after: "finally{}",
    test: "plugins/sandbox/src/__test__/worker-contract.test.ts",
    pattern: "wide directory scans",
  },
  {
    name: "resource conflicts ignored",
    file: "plugins/tools/src/planning/conflicts.ts",
    before: "return a.some",
    after: "return false&&a.some",
    test: "plugins/tools/src/__test__/resource-locks.test.ts",
    pattern: "shared resource matrix",
  },
  {
    name: "revocable predicate ignored",
    file: "plugins/tools/src/planning/check-plan.ts",
    before: "permission.isValid()!==true",
    after: "false",
    test: "plugins/tools/src/__test__/preparation.test.ts",
    pattern: "policy predicates can revoke",
  },
  {
    name: "prepared status retains request scope",
    file: "plugins/tools/src/planning/prepare-tool.ts",
    before: "const handle=createPreparedHandle(plan);",
    after: "const handle:PreparedTool=Object.freeze({plan,status:()=>checkPlan(handle)});",
    test: "plugins/tools/src/__test__/execution-retention.test.ts",
    pattern: "retained closed execution",
  },
  {
    name: "process group completion not awaited",
    file: "plugins/execution-process/src/run-process.ts",
    before: "await waitProcessGroup(child.pid);",
    after: "",
    test: "plugins/execution-process/src/__test__/process.test.ts",
    pattern: "closed output pipe",
  },
  {
    name: "sandbox process creation permitted",
    file: "plugins/sandbox/src/create-rules.ts",
    before: "(deny process-fork)",
    mode: "raw" as const,
    after: "(allow process-fork)",
    test: "plugins/sandbox/src/__test__/sandbox.test.ts",
    pattern: "real SRT prevents fork",
  },
  {
    name: "hard link validation removed",
    file: "plugins/sandbox/src/check-filesystem-roots.ts",
    before: "info.isFile()&&info.nlink>1",
    after: "false",
    test: "plugins/sandbox/src/__test__/sandbox.test.ts",
    pattern: "read-only hard-link aliases",
  },
  {
    name: "proxy environment lost",
    file: "plugins/sandbox/src/sandbox-worker.ts",
    before:
      'const proxyKeys=["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy"]',
    after: "const proxyKeys:string[]=[]",
    test: "plugins/sandbox/src/__test__/sandbox.test.ts",
    pattern: "network proxy routing",
  },
  {
    name: "read-only roots become writable",
    file: "plugins/sandbox/src/sandbox-worker.ts",
    before: "allowWrite:[...profile.writeRoots,work]",
    after: "allowWrite:[...profile.readRoots,work]",
    extra: [
      {
        file: "plugins/sandbox/src/create-rules.ts",
        before: "...options.writeRoots,options.scratch",
        after: "...options.readRoots,options.scratch",
      },
    ],
    test: "plugins/sandbox/src/__test__/sandbox.test.ts",
    pattern: "real SRT executes allowed reads",
  },
  {
    name: "changed target identity accepted",
    file: "plugins/execution-process/src/check-target.ts",
    before: "current.dev!==identity.dev||current.ino!==identity.ino",
    after: "false",
    test: "plugins/execution-local/src/__test__/local.test.ts",
    pattern: "executable symlink replacement",
  },
];
const directory = await mkdtemp(resolve(tmpdir(), "execution-mutations-")),
  target = resolve(directory, "packages/v2");
const reports: { name: string; detected: boolean; code: number; evidence: string }[] = [];

async function run(paths: string[], pattern?: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(root, "../../node_modules/vitest/vitest.mjs"),
      "run",
      ...paths,
      ...(pattern ? ["-t", pattern] : []),
    ],
    { cwd: target, stdout: "pipe", stderr: "pipe", timeout: 20000 },
  );
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: out + err };
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
  const baseline = await run([...new Set(cases.map((c) => c.test))]);
  const baselineCases = Number(/Tests\s+(\d+) passed/.exec(baseline.output)?.[1] ?? 0);

  if (baseline.code || !baselineCases)
    throw new Error("Execution mutation baseline failed: " + baseline.output);

  for (const mutation of cases) {
    const originals: { path: string; source: string }[] = [];

    try {
      for (const edit of [mutation, ...("extra" in mutation ? (mutation.extra ?? []) : [])]) {
        const path = resolve(target, edit.file),
          source = await readFile(path, "utf8");
        originals.push({ path, source });
        await writeFile(path, applyMutation(source, edit));
      }

      const result = await run([mutation.test], mutation.pattern);
      const detected =
        result.code !== 0 &&
        result.output.includes("AssertionError:") &&
        !result.output.includes("Test timed out") &&
        !result.output.includes("Failed to resolve");
      const evidence =
        result.output.split("\n").find((line) => line.includes("AssertionError:")) ??
        result.output.slice(0, 1200);
      reports.push({ name: mutation.name, detected, code: result.code, evidence });
      process.stdout.write(`${detected ? "detected" : "SURVIVED"}: ${mutation.name}\n`);
    } finally {
      for (const { path, source } of originals) await writeFile(path, source);
    }
  }

  await mkdir(resolve(root, "reviews/tool-execution"), { recursive: true });
  await writeFile(
    resolve(root, "reviews/tool-execution/mutations.json"),
    JSON.stringify(
      {
        command: "bun run test:execution:mutations",
        runtime: Bun.version,
        platform: process.platform,
        baselineCases,
        reports,
      },
      null,
      2,
    ) + "\n",
  );

  if (reports.some((r) => !r.detected))
    throw new Error("An execution mutation was not rejected by a behavioral assertion");
} finally {
  await rm(directory, { recursive: true, force: true });
}
