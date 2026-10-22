import { expect, it } from "vitest";

it.each(["normal", "native-any", "retain-source"])(
  "completed cancellation samples release external reasons and detect retained-source controls: %s",
  async (mode) => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./cancellation-ownership.gc-case.ts", import.meta.url).pathname,
        mode,
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_JSC_useJIT: "false" } },
    );
    const timer = setTimeout(() => child.kill(), 5000);

    try {
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      if (mode === "normal")
        expect({ status, stdout, stderr }).toEqual({
          status: 0,
          stdout: "collected\n",
          stderr: "",
        });
      else {
        expect(status).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("Saved invocation retained the raw external cancellation reason");
      }
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  },
);
