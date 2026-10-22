import { expect, it } from "vitest";
it("source and built tool plugins share identity and drain actual HTTP work in a fresh process", async () => {
  const child = Bun.spawn(
    [process.execPath, new URL("./tools-built-case.ts", import.meta.url).pathname],
    { stdout: "pipe", stderr: "pipe", timeout: 4000 },
  );

  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("tools HTTP build passed");
  } finally {
    child.kill();
    await child.exited;
  }
});
