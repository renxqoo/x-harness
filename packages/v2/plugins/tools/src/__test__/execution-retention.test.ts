import { expect, it } from "vitest";
it("retained closed execution facade prepared handle and commit release the request with a working GC control", async () => {
  const child = Bun.spawn(
    [process.execPath, new URL("./execution-retention.gc-case.ts", import.meta.url).pathname],
    { stdout: "pipe", stderr: "pipe", timeout: 4000 },
  );

  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      control: true,
      subject: true,
      late: { ok: false, error: { code: "closed" } },
      status: { ok: false },
    });
  } finally {
    child.kill();
    await child.exited;
  }
});
