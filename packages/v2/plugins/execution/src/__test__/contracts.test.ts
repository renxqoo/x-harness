import { expect, it } from "vitest";
import {
  createExecutionTarget,
  readExecutionTarget,
  readExecutionOutput,
  readExecutionError,
  readResources,
} from "../index";
const target = {
  backend: "test",
  profile: "readonly",
  argv: ["/bin/echo", "ok"],
  cwd: "/tmp",
  env: {},
  resources: [],
  restrictions: { network: false },
} as const;
it("execution targets are frozen and cannot be forged", () => {
  const result = createExecutionTarget(target);
  expect(result.ok).toBe(true);

  if (!result.ok) return;

  expect(Object.isFrozen(result.value)).toBe(true);
  expect(readExecutionTarget(result.value).ok).toBe(true);
  expect(readExecutionTarget({ ...result.value }).ok).toBe(false);
  expect(readExecutionOutput({ exitCode: 0, stdout: "x", stderr: "" }).ok).toBe(true);
  expect(readExecutionError({ source: "execution", code: "closed", message: "closed" }).ok).toBe(
    true,
  );
});
it.each([
  null,
  [],
  {},
  { ...target, extra: true },
  { ...target, argv: ["/bin/echo", "a\0b"] },
  { ...target, cwd: "/tmp\0bad" },
  { ...target, env: { "A=B": "x" } },
  { ...target, env: { A: "bad\0value" } },
  { ...target, argv: [] },
  { ...target, argv: ["echo"] },
  { ...target, env: { x: 42 } },
  { ...target, resources: [{ domain: "x", path: [".."], scope: "exact", mode: "read" }] },
])("invalid execution targets return errors %#", (raw) => {
  expect(() => createExecutionTarget(raw as never)).not.toThrow();
  expect(createExecutionTarget(raw as never).ok).toBe(false);
});
it.each([
  {},
  { exitCode: 0, stdout: "x", stderr: "", extra: 1 },
  { exitCode: 1.5, stdout: "", stderr: "" },
  null,
])("invalid execution output is rejected %#", (raw) => {
  expect(readExecutionOutput(raw).ok).toBe(false);
});
it.each([
  {},
  { source: "execution", code: "closed", message: "secret" },
  { source: "execution", code: "other", message: "other" },
])("invalid errors do not expose arbitrary messages %#", (raw) => {
  expect(readExecutionError(raw).ok).toBe(false);
});
it("resource normalization deduplicates claims with the strongest mode", () => {
  const base = { domain: "store", path: ["key"], scope: "exact" } as const;
  const result = readResources([
    { ...base, mode: "read" },
    { ...base, mode: "write" },
  ]);
  expect(result).toMatchObject({ ok: true, value: [{ ...base, mode: "write" }] });
});
it.each([
  null,
  {},
  [{ domain: "", path: [], scope: "exact", mode: "read" }],
  [{ domain: "x", path: [".."], scope: "exact", mode: "read" }],
  [{ domain: "x", path: [], scope: "typo", mode: "read" }],
])("malformed resource claims fail safely %#", (raw) => {
  expect(readResources(raw).ok).toBe(false);
});
it.each([
  ["a", 1024, true],
  ["a", 1025, false],
  ["界", 341, true],
  ["界", 342, false],
] as const)("resource segments apply UTF8 bytes for %s x %i", (character, count, ok) => {
  expect(
    readResources([
      { domain: "store", path: [character.repeat(count)], scope: "exact", mode: "read" },
    ]).ok,
  ).toBe(ok);
});
it("combined tool and execution resources deduplicate before applying the final budget", async () => {
  const { mergeResources } = await import("../index");
  const claims = Array.from(
    { length: 65 },
    (_, i) => ({ domain: "store", path: [String(i)], mode: "read", scope: "exact" }) as const,
  );
  const merged = mergeResources(claims, claims);
  expect(merged.ok).toBe(true);

  if (merged.ok) expect(merged.value).toHaveLength(65);

  const strong = mergeResources(claims, [
    { domain: "store", path: [], mode: "write", scope: "subtree" },
  ]);
  expect(strong).toMatchObject({
    ok: true,
    value: [{ domain: "store", path: [], mode: "write", scope: "subtree" }],
  });
});
