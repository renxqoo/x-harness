import { expect, it } from "vitest";
it("saved model callbacks and completed agent streams release their input, callback and service", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--jsc-arg=--useJIT=false",
      new URL("./retention.gc-case.ts", import.meta.url).pathname,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 6000 },
  );

  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("agent retention passed");
  } finally {
    child.kill();
    await child.exited;
  }
});
