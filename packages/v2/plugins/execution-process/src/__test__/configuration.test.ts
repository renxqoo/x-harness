import { expect, it } from "vitest";
import { tmpdir } from "node:os";
import { createProcessExecutionPlugin } from "../index";

const options = () => ({ profiles: { test: { cwd: tmpdir() } } });

const backend = () => ({
  name: "test",
  isolation: "none" as const,
  run: async () => ({ ok: true as const, value: { exitCode: 0, stdout: "", stderr: "" } }),
});

it.each([
  null,
  {},
  { profiles: {} },
  { profiles: { bad: { cwd: "relative" } } },
  { profiles: { "!": { cwd: "/" } } },
  { ...options(), limits: { maxActiveRequests: 0 } },
  { ...options(), limits: { constructor: 1 } },
  { profiles: { test: { cwd: "/", env: { BAD: 1 } } } },
  { profiles: { test: { cwd: "/", allowEnv: ["A=B"] } } },
  { profiles: { test: { cwd: "/", allowedDomains: ["https://example.com"] } } },
  { profiles: { test: { cwd: "/", unknown: true } } },
] as unknown[])("configuration rejects malformed profile and budget shapes %#", async (raw) => {
  expect(createProcessExecutionPlugin(raw as never, backend())).toMatchObject({
    ok: false,
    error: { code: "invalid-input" },
  });
});
it.each([
  null,
  {},
  { ...backend(), name: "!" },
  { ...backend(), isolation: "unknown" },
  { ...backend(), run: null },
  { ...backend(), systemReadRoots: ["relative"] },
  { ...backend(), systemReadRoots: [2] },
] as unknown[])("backend options fail without accessing hostile runtime values %#", async (raw) => {
  expect(createProcessExecutionPlugin(options(), raw as never)).toMatchObject({
    ok: false,
    error: { code: "invalid-input" },
  });
});
it("backend descriptor snapshots do not invoke proxy property access", async () => {
  const proxy = new Proxy(backend(), {
    get() {
      throw new Error("secret");
    },
  });
  expect(createProcessExecutionPlugin(options(), proxy).ok).toBe(true);
});
