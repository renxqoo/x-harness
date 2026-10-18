import { cp, mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { mutationCases } from "./llm/mutation-cases";
const root = resolve(import.meta.dir, ".."); const directory = await mkdtemp(resolve(tmpdir(), "llm-mutations-")); const target = resolve(directory, "packages/v2"); const reports: { name: string; detected: boolean; code: number; evidence: string }[] = [];
try {
  await mkdir(resolve(directory, "packages")); await cp(root, target, { recursive: true, filter: (path) => !["node_modules", "dist", "coverage", ".git"].includes(path.split("/").at(-1)!) }); await symlink(resolve(root, "../../node_modules"), resolve(directory, "node_modules")); await symlink(resolve(root, "node_modules"), resolve(target, "node_modules"));
  const baselineChild = Bun.spawn([process.execPath, resolve(root, "../../node_modules/vitest/vitest.mjs"), "run", ...new Set(mutationCases.map((item) => item.test))], { cwd: target, stdout: "pipe", stderr: "pipe", timeout: 30000 });
  const [baselineCode, baselineOut, baselineErr] = await Promise.all([baselineChild.exited, new Response(baselineChild.stdout).text(), new Response(baselineChild.stderr).text()]); const baseline = { code: baselineCode, cases: Number(/Tests\s+(\d+) passed/.exec(baselineOut + baselineErr)?.[1] ?? 0) }; if (baseline.code || !baseline.cases) throw new Error(`Mutation baseline failed: ${baselineOut + baselineErr}`);
  for (const mutation of mutationCases) {
    const path = resolve(target, mutation.file); const source = await readFile(path, "utf8"); if (!source.includes(mutation.before)) throw new Error(`Mutation anchor absent: ${mutation.name}`); await writeFile(path, source.replace(mutation.before, mutation.after));
    try { const child = Bun.spawn([process.execPath, resolve(root, "../../node_modules/vitest/vitest.mjs"), "run", mutation.test, "-t", mutation.pattern], { cwd: target, stdout: "pipe", stderr: "pipe", timeout: 20000 }); const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); const output = stdout + stderr; const evidence = output.split("\n").find((line) => line.includes("AssertionError:")) ?? output.slice(0, 1200); const detected = code !== 0 && output.includes("AssertionError:") && !output.includes("Test timed out") && !output.includes("Failed to resolve"); reports.push({ name: mutation.name, detected, code, evidence }); process.stdout.write(`${detected ? "detected" : "SURVIVED"}: ${mutation.name}\n`); }
    finally { await writeFile(path, source); }
  }
  await writeFile(resolve(root, "plugins/llm/reviews/mutations.json"), JSON.stringify({ command: "bun scripts/verify-llm-mutations.ts", runtime: Bun.version, baseline, reports }, null, 2) + "\n"); if (reports.some((report) => !report.detected)) throw new Error("LLM mutation control survived or lacked behavioral evidence");
} finally { await rm(directory, { recursive: true, force: true }); }
