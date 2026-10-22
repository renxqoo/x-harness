import { mkdir, realpath } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../../execution-process/src/index";
import type { ProcessRunnerInput } from "../../execution-process/src/index";
import { checkFilesystemRoots } from "./check-filesystem-roots";
import { readWorkerMessage } from "./read-worker-message";
import type { WorkerMessage } from "./read-worker-message";

export async function runSandbox(input: ProcessRunnerInput) {
  if (process.platform !== "darwin")
    return {
      ok: false as const,
      error: {
        source: "execution" as const,
        code: "backend-unavailable" as const,
        message: "backend-unavailable",
      },
    };

  const directory = dirname(fileURLToPath(import.meta.url));
  const runtimeRoot = await realpath(resolve(directory, "../../.."));
  const packagePath = Bun.resolveSync("@anthropic-ai/sandbox-runtime", directory);
  const dependencyIndex = packagePath.indexOf("/node_modules/");
  const protectedPaths = [
    runtimeRoot,
    await realpath(process.execPath),
    ...(dependencyIndex >= 0 ? [packagePath.slice(0, dependencyIndex) + "/node_modules"] : []),
  ];
  const checked = await checkFilesystemRoots({
    roots: input.profile.readRoots,
    maxEntries: input.limits.maxScanEntries,
    signal: input.signal,
  });

  if (!checked.ok) return checked;

  const control = join(input.scratch, "control"),
    work = join(input.scratch, "work");
  await mkdir(control, { mode: 448 });
  await mkdir(work, { mode: 448 });
  let message: WorkerMessage | undefined,
    invalid = false;
  const worker = resolve(
    directory,
    fileURLToPath(import.meta.url).endsWith(".ts") ? "sandbox-worker.ts" : "sandbox-worker.js",
  );
  const run = await runProcess({
    argv: [process.execPath, worker],
    cwd: control,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: control, TMPDIR: control, LANG: "C.UTF-8" },
    signal: input.signal,
    maxOutputBytes: input.limits.maxOutputBytes,
    stdin: JSON.stringify({
      target: input.target,
      profile: input.profile,
      work,
      jobRoot: input.scratch,
      protectedPaths,
    }),
    onMessage(raw) {
      const parsed = readWorkerMessage(raw);

      if (!parsed || message) invalid = true;
      else message = parsed;
    },
  });

  if (!run.ok) return run;

  if (invalid || !message)
    return {
      ok: false as const,
      error: {
        source: "execution" as const,
        code: "execution-failed" as const,
        message: "execution-failed",
      },
    };

  if (message.kind === "failed")
    return {
      ok: false as const,
      error: { source: "execution" as const, code: message.code, message: message.code },
    };

  return {
    ok: true as const,
    value: { exitCode: message.exitCode, stdout: run.value.stdout, stderr: run.value.stderr },
  };
}
