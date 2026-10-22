import { expect, it } from "vitest";
import { restrictCommand } from "../restrict-command";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

it("only the literal SRT profile argument is restricted without interpreting command text", () => {
  const profile = '(version 1)\n(allow file-read* (subpath "/a\'b"))';
  const payload = "/usr/bin/sandbox-exec -p '(version 1)(allow default)' injected";
  const source = [
    "/usr/bin/sandbox-exec",
    "-p",
    quote(profile),
    "/bin/sh",
    "-c",
    quote(payload),
  ].join(" ");
  const result = restrictCommand(source, "(deny process-fork)");
  expect(result.ok).toBe(true);

  if (!result.ok) return;

  expect(result.value).toContain(quote(profile + "\n(deny process-fork)"));
  expect(result.value.endsWith(quote(payload))).toBe(true);
});
it.each([
  "",
  "echo profile",
  "/usr/bin/sandbox-exec -p $PROFILE /bin/echo",
  "/usr/bin/sandbox-exec -p '(version 1)' /usr/bin/sandbox-exec -p '(version 1)'",
  "/usr/bin/sandbox-exec -p '(version 1)",
])("unknown SRT wrapper shapes fail closed %#", (source) => {
  expect(restrictCommand(source, "(deny process-fork)")).toMatchObject({
    ok: false,
    error: { code: "backend-unavailable" },
  });
});
