import { expect, it } from "vitest";

it("retained author contexts and completed invocation dependencies do not keep retired tokens alive", async () => {
  const child = Bun.spawn(
    ["bun", new URL("./derived-capabilities.gc-case.ts", import.meta.url).pathname],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_JSC_useJIT: "false" } },
  );
  const timer = setTimeout(() => child.kill(), 5000);

  try {
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ stdout, stderr, status }).toEqual({ stdout: "collected\n", stderr: "", status: 0 });
  } finally {
    clearTimeout(timer);
    child.kill();
  }
});
