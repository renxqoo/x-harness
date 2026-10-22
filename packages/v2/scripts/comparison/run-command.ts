import assert from "node:assert/strict";

export async function runCommand(
  command: string[],
  environment: Record<string, string | undefined>,
  expected: "success" | "type-error" = "success",
) {
  const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: environment,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 30000);

  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert(!timedOut, "Comparison child exceeded its deadline");

    if (expected === "success") assert.equal(status, 0, stdout + stderr);
    else {
      assert(
        typeof status === "number" && status > 0,
        "Invalid author source compiled successfully or was terminated",
      );
      assert(/error TS\d+/.test(stdout), stdout + stderr);
    }

    assert.equal(stderr, "");
    return stdout;
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}
