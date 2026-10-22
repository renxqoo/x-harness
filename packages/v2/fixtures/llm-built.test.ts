import { expect, it } from "vitest";
it("compiled core and all compiled LLM protocols share token identity in a fresh process", async () => {
  const child = Bun.spawn(
    [process.execPath, new URL("./llm-built-case.ts", import.meta.url).pathname],
    { stdout: "pipe", stderr: "pipe", timeout: 4000 },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("built protocols passed");
});
