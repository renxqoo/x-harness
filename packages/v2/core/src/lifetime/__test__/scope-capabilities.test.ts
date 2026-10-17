import { afterEach, describe, expect, it } from "vitest";
import { createHost, defineChain, defineService } from "../../index";
import type { Context, Disposer, Limits, Result, Host, Validator } from "../../index";

const hosts: Host[] = [];
function take<T, E>(result: Result<T, E>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected successful Result");
  return result.value;
}
function host() {
  const value = take(createHost());
  hosts.push(value);
  return value;
}
function service(name: string) {
  return take(defineService<{ run(input: string): Promise<Result<string>> }>({ name, methods: { run: {} } }));
}
afterEach(async () => { for (const root of hosts.splice(0)) take(await root.close()); });
const text: Validator<string> = (input) => typeof input === "string"
  ? { ok: true, value: input }
  : { ok: false, error: { source: "core", code: "invalid-input", message: "Expected string" } };

describe("scoped capability delegation", () => {
  it("scopes created before providing self capabilities keep the fixed provider through nested scopes", async () => {
    const root = host();
    const token = service("owned-capability");
    const restricted = service("restricted-capability");
    let child!: Context;
    let nested!: Context;
    take(root.register(restricted, { run: (input) => Promise.resolve({ ok: true, value: input }) }));
    const installed = take(await root.install([{ name: "creator", provides: { token }, setup(ctx) {
      child = take(ctx.createScope({ label: "child" }));
      nested = take(child.createScope({ label: "nested" }));
      return ctx.register(token, { run: (input) => Promise.resolve({ ok: true, value: input }) });
    } }]));
    expect(take(await take(child.use(token)).run("child"))).toBe("child");
    const saved = take(nested.use(token));
    expect(take(await saved.run("nested"))).toBe("nested");
    expect(child.use(restricted)).toMatchObject({ ok: false, error: { code: "undeclared-dependency" } });
    take(await root.uninstall(installed.plugins[0]!));
    expect(await saved.run("stale")).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    expect(child.scopeState).toBe("closed");
    expect(nested.scopeState).toBe("closed");
  });

  it("explicit local shadow overrides delegated self capability without replacing the parent", async () => {
    const root = host();
    const token = service("shadowed-self");
    let child!: Context;
    take(await root.install([{ name: "creator", provides: { token }, setup(ctx) {
      const provided = ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "parent" }) });
      if (!provided.ok) return provided;
      child = take(ctx.createScope({ label: "shadow" }));
      const local = child.register(token, { run: () => Promise.resolve({ ok: true, value: "child" }) }, { shadow: true });
      if (!local.ok) return local;
      return { ok: true, value: undefined };
    } }]));
    expect(take(await take(root.use(token)).run("read"))).toBe("parent");
    expect(take(await take(child.use(token)).run("read"))).toBe("child");
  });

  it("an inherited binding keeps resolving after the local shadow is revoked", async () => {
    const root = host();
    const token = service("revoked-self-shadow");
    let child!: Context;
    let remove!: Disposer;
    take(await root.install([{ name: "creator", provides: { token }, setup(ctx) {
      const provided = ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "parent" }) });
      if (!provided.ok) return provided;
      child = take(ctx.createScope({ label: "shadow" }));
      const local = child.register(token, { run: () => Promise.resolve({ ok: true, value: "child" }) }, { shadow: true });
      if (!local.ok) return local;
      remove = local.value;
      return { ok: true, value: undefined };
    } }]));
    const saved = take(child.use(token));
    expect(take(await saved.run("first"))).toBe("child");
    take(await remove());
    expect(take(await take(child.use(token)).run("fallback"))).toBe("parent");
    expect(await saved.run("stale")).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    expect(take(await take(root.use(token)).run("parent"))).toBe("parent");
  });

  it.each([null, false, 0, "", true])("explicit invalid scope limits are not silently ignored: %s", (limits) => {
    const root = host();
    expect(root.createScope({ label: "invalid", limits: limits as unknown as Partial<Limits> })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(root.inspect().scopes).toBe(1);
  });

  it("scope limits cannot use prototype keys or increase an inherited budget", () => {
    const root = host();
    expect(root.createScope({ label: "prototype", limits: { toString: 1 } as unknown as Partial<Limits> })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    const parent = take(root.createScope({ label: "parent", limits: { maxActiveCalls: 1 } }));
    expect(parent.createScope({ label: "larger", limits: { maxActiveCalls: 2 } })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    take(parent.createScope({ label: "same", limits: { maxActiveCalls: 1 } }));
  });

  it("a missing chain provider is classified as an unavailable extension including absent optional binding", async () => {
    const root = host();
    const chain = take(defineChain({ name: "missing-chain", input: text, output: text }));
    expect(await root.dispatch(chain, "request")).toMatchObject({ ok: false, error: { code: "extension-unavailable" } });
    take(await root.install([{ name: "consumer", optional: { chain }, async setup(ctx) {
      expect(await ctx.dispatch(chain, "request")).toMatchObject({ ok: false, error: { code: "extension-unavailable" } });
      return { ok: true, value: undefined };
    } }]));
  });
});
