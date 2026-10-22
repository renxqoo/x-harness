import { expect, it } from "vitest";
it("saved grant and catalog callbacks release revoked requests and retired contributions", async () => {
  const child = Bun.spawn(
    [process.execPath, new URL("./public-extension.gc-case.ts", import.meta.url).pathname],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
      env: { ...process.env, BUN_JSC_useJIT: "false" },
    },
  );

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ stdout, stderr, code }).toEqual({ stdout: "passed\n", stderr: "", code: 0 });
  } finally {
    child.kill();
    await child.exited;
  }
});
