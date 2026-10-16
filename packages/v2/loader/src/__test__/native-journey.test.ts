import { expect, it } from "vitest";

it.each(["source", "built", "budget"])("native Bun loader journey %s closes HTTP services and bounds module imports", async (mode) => {
  if (mode !== "source") {
    const build = Bun.spawn(["bun", new URL("../../../scripts/build.ts", import.meta.url).pathname], { stdout: "pipe", stderr: "pipe" });
    const [status, stderr] = await Promise.all([build.exited, new Response(build.stderr).text(), new Response(build.stdout).text()]); expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  }
  const child = Bun.spawn(["bun", new URL("./loader.e2e-case.ts", import.meta.url).pathname, mode], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ mode, stdout, stderr, status }).toEqual({ mode, stdout: "passed\n", stderr: "", status: 0 });
  } finally { clearTimeout(timer); child.kill(); }
}, 12000);
