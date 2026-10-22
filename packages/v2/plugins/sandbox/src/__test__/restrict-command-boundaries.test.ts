import { expect, it } from "vitest";
import { restrictCommand } from "../restrict-command";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

it("double-quoted and backslash-escaped literal profiles receive restrictions without changing shell suffixes", () => {
  const rules = '(deny file-write* (subpath "/private"))';
  const doubleQuoted =
    '/usr/bin/sandbox-exec -p "(version 1)\n(allow file-read* (subpath \\"/a\\"))" /bin/echo done';
  const escaped = "/usr/bin/sandbox\\-exec -p '(version 1)' /bin/echo done";
  const result = restrictCommand(doubleQuoted, rules);

  expect(result).toEqual({
    ok: true,
    value:
      "/usr/bin/sandbox-exec -p " +
      quote('(version 1)\n(allow file-read* (subpath "/a"))\n' + rules) +
      " /bin/echo done",
  });
  expect(restrictCommand(escaped, rules)).toEqual({
    ok: true,
    value: "/usr/bin/sandbox\\-exec -p " + quote("(version 1)\n" + rules) + " /bin/echo done",
  });
});

it("literal concatenated quotes preserve the complete profile and append restrictions exactly once", () => {
  const source = "/usr/bin/sandbox-exec -p '(version '1')' /bin/echo done";

  expect(restrictCommand(source, "(deny process-fork)")).toEqual({
    ok: true,
    value: "/usr/bin/sandbox-exec -p '(version 1)\n(deny process-fork)' /bin/echo done",
  });
});

it.each([
  '/usr/bin/sandbox-exec -p "(version 1)$PROFILE" /bin/echo',
  '/usr/bin/sandbox-exec -p "(version 1)`id`" /bin/echo',
  "/usr/bin/sandbox-exec -p `(version 1)` /bin/echo",
  '/usr/bin/sandbox-exec -p "(version 1)',
  '/usr/bin/sandbox-exec -p "(version 1)\\',
  "/usr/bin/sandbox-exec -p '(version 1)' /bin/echo \\",
])("dynamic or incomplete shell words never receive a falsely trusted profile %#", (source) => {
  expect(restrictCommand(source, "(deny process-fork)")).toMatchObject({
    ok: false,
    error: { code: "backend-unavailable" },
  });
});

it.each([
  ["x".repeat(1048577), "(deny process-fork)"],
  ["/usr/bin/sandbox-exec -p '(version 1)' /bin/echo", "x".repeat(262145)],
])(
  "wrapper and restriction size limits fail before parsing oversized shell text %#",
  (source, rules) => {
    expect(restrictCommand(source!, rules!)).toMatchObject({
      ok: false,
      error: { code: "backend-unavailable" },
    });
  },
);
