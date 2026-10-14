import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("a saved disposer cannot retain a successfully closed runtime", async () => {
  const child = Bun.spawn(["bun", fileURLToPath(new URL("./collect-closed-runtime.gc-case.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" });
  const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(error).toBe("");
  expect(status).toBe(0);
  expect(output).toBe("closed runtime collected\n");
});
