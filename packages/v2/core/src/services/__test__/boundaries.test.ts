import { afterEach, describe, expect, it } from "vitest";
import { defineService } from "../../index";
import type { Context, Invocation, Result, RootContext } from "../../index";
import { deferred, flush, root, value } from "../../__test__/helpers";

const roots: RootContext[] = [];
afterEach(async () => { for (const item of roots.splice(0)) await item.dispose(); });
const setup = (options?: Parameters<typeof root>[0]) => { const item = root(options); roots.push(item); return item; };
const service = (name: string) => value(defineService<{ run(input: string): Promise<Result<string>> }>({ name, methods: { run: {} } }));

describe("service registration and invocation boundaries", () => {
  it("failed implementation validation does not reserve its public definition name", () => {
    const host = setup();
    const first = service("retry");
    expect(host.provide(first, {} as Parameters<Context["provide"]>[1]).ok).toBe(false);
    const valid = service("retry");
    expect(host.provide(valid, { run: (input) => Promise.resolve({ ok: true, value: input }) }).ok).toBe(true);
  });
  it("reproviding after revocation creates a new generation and never redirects an old facade", async () => {
    const host = setup(); const token = service("generation");
    const off = value(host.provide(token, { run: () => Promise.resolve({ ok: true, value: "old" }) }));
    const old = value(host.use(token));
    value(await off({ context: host, signal: new AbortController().signal, deadline: Infinity }));
    value(host.provide(token, { run: () => Promise.resolve({ ok: true, value: "new" }) }));
    expect((await old.run("a")).ok).toBe(false);
    expect(value(await value(host.use(token)).run("a"))).toBe("new");
  });
  it("repeated use reuses a fixed facade and does not exhaust lease metadata", () => {
    const host = setup({ limits: { maxRegistrationsPerOwner: 2 } }); const token = service("cached");
    value(host.provide(token, { run: (input) => Promise.resolve({ ok: true, value: input }) }));
    const first = value(host.use(token));
    for (let call = 0; call < 1000; call += 1) expect(value(host.use(token))).toBe(first);
  });
  it("repeated install and unload do not consume retained old facade capacity", async () => {
    const host = setup({ limits: { maxRegistrationsPerOwner: 2 } }); const token = service("repeat");
    const facades: { run(input: string): Promise<Result<string>> }[] = [];
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const installed = value(await host.load([{ name: "provider", provides: [token], apply(ctx) { return ctx.provide(token, { run: (input) => Promise.resolve({ ok: true, value: input }) }); } }]));
      facades.push(value(host.use(token)));
      value(await host.unload(installed.plugins[0]!));
    }
    for (const facade of facades) expect((await facade.run("stale")).ok).toBe(false);
    expect(host.inspect().effects).toBe(0);
  });
  it("call budget refusal prevents the second implementation from entering", async () => {
    const host = setup({ limits: { maxActiveCalls: 1 } }); const token = service("limited");
    const gate = deferred<Result<string>>(); let calls = 0;
    value(host.provide(token, { run() { calls += 1; return gate.promise; } }));
    const first = value(host.use(token)).run("first"); await flush();
    expect(await value(host.use(token)).run("second")).toMatchObject({ ok: false, reason: { code: "resource-limit" } });
    expect(calls).toBe(1);
    gate.resolve({ ok: true, value: "done" }); value(await first);
  });
  it("definition and registration budgets do not leave partially available capabilities", () => {
    const host = setup({ limits: { maxDefinitions: 1, maxRegistrationsPerOwner: 1 } });
    const first = service("first"); const second = service("second");
    value(host.provide(first, { run: (input) => Promise.resolve({ ok: true, value: input }) }));
    expect(host.provide(second, { run: (input) => Promise.resolve({ ok: true, value: input }) })).toMatchObject({ ok: false, reason: { code: "resource-limit" } });
    expect(host.use(second).ok).toBe(false);
    expect(host.effect(() => ({ ok: true, value: undefined })).ok).toBe(false);
    expect(host.inspect().effects).toBe(1);
  });
  it("nested bind preserves parent identity and rejects a saved facade after the parent ends", async () => {
    const host = setup(); const a = service("a"); const b = service("b");
    let parent!: Invocation; let child!: Invocation; let saved!: { run(input: string): Promise<Result<string>> };
    value(await host.load([
      { name: "b", provides: [b], apply(ctx) { return ctx.provide(b, { run(input, call) { child = call; return Promise.resolve({ ok: true, value: input }); } }); } },
      { name: "a", provides: [a], requires: [b], apply(ctx) { return ctx.provide(a, { async run(input, call) {
        parent = call;
        const bound = value(call.bind(ctx)); saved = value(bound.use(b));
        return saved.run(input);
      } }); } },
    ]));
    value(await value(host.use(a)).run("nested"));
    expect(child.parentId).toBe(parent.id);
    expect(child.origin.pluginName).toBe("a");
    expect(child.resourceOwner).toEqual(parent.resourceOwner);
    expect(child.deadline).toBeLessThanOrEqual(parent.deadline);
    expect((await saved.run("late")).ok).toBe(false);
  });
  it.each([{ ok: true }, { ok: false }, { ok: true, value: 1, reason: "wrong" }, { ok: false, reason: undefined }, { ok: "true", value: 1 }])("malformed result is rejected: %j", async (result) => {
    const host = setup(); const token = service("malformed");
    value(host.provide(token, { run: () => Promise.resolve(result as unknown as Result<string>) }));
    expect(await value(host.use(token)).run("a")).toMatchObject({ ok: false, reason: { code: "invalid-result" } });
  });
  it.each([{ source: "core" }, { source: "core", code: "unknown", message: "bad" }, { source: "core", code: "timeout", message: 1 }])("reserved core failure is validated: %j", async (reason) => {
    const host = setup(); const token = service("reserved");
    value(host.provide(token, { run: () => Promise.resolve({ ok: false, reason } as unknown as Result<string>) }));
    expect(await value(host.use(token)).run("a")).toMatchObject({ ok: false, reason: { code: "invalid-result" } });
  });
  it("business failure validator is enforced without converting the original reason", async () => {
    const host = setup(); const reason = { code: "timeout" as const, domain: "model" };
    const token = value(defineService<{ run(input: string): Promise<Result<string, typeof reason>> }>({ name: "business", methods: { run: { failure: (raw) => raw === reason ? { ok: true, value: reason } : { ok: false, reason: { source: "core", code: "invalid-input", message: "invalid-input" } } } } }));
    value(host.provide(token, { run: () => Promise.resolve({ ok: false, reason }) }));
    const result = await value(host.use(token)).run("a");
    expect(result).toEqual({ ok: false, reason });
    if (!result.ok) expect(result.reason).toBe(reason);
  });
});
