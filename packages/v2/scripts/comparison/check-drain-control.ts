import assert from "node:assert/strict";
import { cp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand } from "./run-command";

export async function checkDrainControl(
  temporary: string,
  environment: Record<string, string | undefined>,
) {
  const workspace = resolve(import.meta.dir, "../..");
  const mutant = resolve(temporary, "drain-control");

  for (const directory of ["core/src", "application/src", "scripts/comparison"])
    await cp(resolve(workspace, directory), resolve(mutant, directory), {
      recursive: true,
      filter: (path) => !path.split("/").includes("__test__"),
    });

  const file = resolve(mutant, "core/src/lifetime/close-owner.ts");
  const source = await readFile(file, "utf8");
  const removed =
    "    while (owner.activities.size) await Promise.all([...owner.activities].map((entry) => entry.actual));\n";
  assert.equal(source.split(removed).length, 2);
  await writeFile(file, source.replace(removed, ""));
  const expected = {
    closedBeforeGate: false,
    replacementSettledBeforeGate: false,
    bodySawClosed: false,
    savedEntryBlocked: true,
    next: "new",
  };
  const results: Record<string, { detected: boolean; result: unknown }> = {};

  for (const [name, entry] of [
    ["normal", resolve(import.meta.dir, "harness/drain-replacement.ts")],
    ["withoutActualDrain", resolve(mutant, "scripts/comparison/harness/drain-replacement.ts")],
  ] as const) {
    const script = `import assert from "node:assert/strict"; import { drainReplacement } from ${JSON.stringify(entry)}; const result = await drainReplacement(); let detected = false; try { assert.deepEqual(result, ${JSON.stringify(expected)}); } catch { detected = true; } process.stdout.write(JSON.stringify({ detected, result }));`;
    const worker = resolve(temporary, `control-${name}.ts`);
    await writeFile(worker, script);
    const output: unknown = JSON.parse(await runCommand([process.execPath, worker], environment));
    assert(output && typeof output === "object" && "detected" in output && "result" in output);
    assert.equal(output.detected, name === "withoutActualDrain");
    assert.deepEqual(
      output.result,
      name === "normal"
        ? expected
        : {
            ...expected,
            closedBeforeGate: true,
            replacementSettledBeforeGate: true,
            bodySawClosed: true,
          },
    );
    results[name] = { detected: output.detected as boolean, result: output.result };
  }

  return results;
}
