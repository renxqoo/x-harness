import { expect, it } from "vitest";

it.each(["setup", "map", "service", "kernel"])("saved %s dependencies release every retired token", async (mode) => {
  const child = Bun.spawn([process.execPath, new URL("./dependency-slots.gc-case.ts", import.meta.url).pathname, mode], { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_JSC_useJIT: "false" } });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(""); expect(status).toBe(0); expect(JSON.parse(stdout)).toEqual({ mode, checkedTokens: 136, retained: 0, checkedKernels: mode === "kernel" ? 8 : 0, retainedKernels: 0 });
  } finally { clearTimeout(timer); child.kill(); }
});
