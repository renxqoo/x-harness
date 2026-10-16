import { expect, it } from "vitest";
import { createHost, defineService, validatePlugin } from "../../index";
import { value } from "../../__test__/helpers";

const ok = () => ({ ok: true as const, value: undefined });
const service = (name: string) => value(defineService<{ run(input: void): Promise<ReturnType<typeof ok>> }>({ name, methods: { run: {} } }));

it.each([null, undefined, [], 1, "plugin", { name: "bad", setup: 1 }, { name: "Bad", setup: ok }, { name: "bad", setup: ok, unknown: 1 },
  { name: "bad", setup: ok, requires: { token: { kind: "service", name: "fake" } } }])("preflight rejects invalid declarations without setup", (input) => {
  expect(validatePlugin(input).ok).toBe(false);
});

it("preflight freezes a copy without executing setup or retaining mutable declaration maps", () => {
  const token = service("dependency"); let called = false;
  const requires = { token }; const raw = { name: "consumer", requires, setup() { called = true; return ok(); } };
  const plugin = value(validatePlugin(raw));
  requires.token = service("replacement"); raw.name = "changed";
  expect(plugin.name).toBe("consumer"); expect(plugin.requires?.token).toBe(token); expect(called).toBe(false);
  expect(Object.isFrozen(plugin)).toBe(true); expect(Object.isFrozen(plugin.requires)).toBe(true);
});

it("preflight rejects conflicting token identity and overlapping declaration slots", () => {
  const first = service("same"); const second = service("same");
  expect(validatePlugin({ name: "bad", requires: { first, second }, setup: ok })).toMatchObject({ ok: false, error: { code: "definition-conflict" } });
  expect(validatePlugin({ name: "bad", requires: { first }, optional: { first }, setup: ok }).ok).toBe(false);
  expect(validatePlugin({ name: "bad", requires: { first }, optional: { another: first }, setup: ok }).ok).toBe(false);
});

it("preflight never invokes declaration accessors", () => {
  let called = false;
  const input = Object.defineProperty({ name: "bad" }, "setup", { get() { called = true; return ok; } });
  expect(validatePlugin(input).ok).toBe(false); expect(called).toBe(false);
});

it("failed planning cannot leave an unregistered consumer pinning the provider", async () => {
  const host = value(createHost()); const token = service("existing"); const missing = service("missing");
  const installed = value(await host.install([{ name: "provider", provides: { token }, setup(ctx) { return ctx.register(token, { run: () => Promise.resolve(ok()) }); } }]));
  expect(await host.install([{ name: "rejected", requires: { token, missing }, setup: ok }])).toMatchObject({ ok: false, error: { code: "missing-dependency" } });
  expect((await host.uninstall(installed.plugins[0]!)).ok).toBe(true); value(await host.close());
});
