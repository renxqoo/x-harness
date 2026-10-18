import { expect, it } from "vitest";
it("retained closed watcher handles and late callbacks release the loader-owned state", async () => {
  const child = Bun.spawn(["bun", new URL("./watch-lifetime.gc-case.ts", import.meta.url).pathname], { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_JSC_useJIT: "false" } });
  const timeout = setTimeout(() => child.kill(), 5000);
  try {
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ stdout, stderr, status }).toEqual({ stdout: "passed\n", stderr: "", status: 0 });
  } finally { clearTimeout(timeout); child.kill(); }
});
