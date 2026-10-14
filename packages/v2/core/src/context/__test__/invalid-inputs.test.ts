import { afterEach, describe, expect, it } from "vitest";
import { createContext, defineChain, defineService } from "../../index";
import type { CallOptions, Context, ContextOptions, DefinitionRef, EventToken, GuardToken, Plugin, ProvideOptions, Result, RootContext, ScopeOptions, TaskSpec } from "../../index";
import { flush, number, root, text, value } from "../../__test__/helpers";

const roots: RootContext[] = [];
afterEach(async () => { for (const item of roots.splice(0)) await item.dispose(); });
const setup = () => { const item = root(); roots.push(item); return item; };
const trap = () => new Proxy({}, { get() { throw new Error("unexpected read"); } });

describe("malformed public inputs", () => {
  it("unrecognized root options and malformed schedulers fail without throwing", () => {
    const inputs = [{ unknown: 1 }, { scheduler: trap() }, { scheduler: { now: 1, delay: 1 } }, { scheduler: { now() { throw new Error("clock"); }, delay() {} } }, { scheduler: { now: () => Infinity, delay() {} } }];
    for (const input of inputs) {
      expect(() => createContext(input as unknown as ContextOptions)).not.toThrow();
      expect(createContext(input as unknown as ContextOptions).ok).toBe(false);
    }
  });
  it("configuration getters are not executed during factory validation", () => {
    let read = 0;
    const input = { get limits() { read += 1; return {}; } };
    expect(createContext(input).ok).toBe(false); expect(read).toBe(0);
  });
  it.each([null, 1, {}, { label: "", run() {} }, { label: "a", run: 1 }, { label: "a", run() {}, unknown: true }].map((input) => ({ input })))("invalid task %j cannot allocate an activity", ({ input }) => {
    const host = setup();
    expect(() => host.spawn(input as unknown as TaskSpec<unknown>)).not.toThrow();
    expect(host.spawn(input as unknown as TaskSpec<unknown>).ok).toBe(false);
    expect(host.inspect().activeTasks).toBe(0);
  });
  it("task and scope descriptor snapshots do not invoke proxy get traps", async () => {
    const host = setup();
    const task = new Proxy({ label: "valid", run: () => ({ ok: true as const, value: 1 }) }, { get() { throw new Error("get trap"); } });
    expect(value(await host.wait(value(host.spawn(task))))).toBe(1);
    const scope = new Proxy({ label: "child" }, { get() { throw new Error("get trap"); } });
    expect(host.scope(scope).ok).toBe(true);
  });
  it.each([null, 1, {}, { label: "" }, { label: "x", limits: { maxScopes: 0 } }].map((input) => ({ input })))("invalid scope %j cannot reserve a scope", ({ input }) => {
    const host = setup(); expect(host.scope(input as unknown as ScopeOptions).ok).toBe(false); expect(host.inspect().scopes).toBe(1);
  });
  it("invalid definition objects cannot enter provide, on, emit or dispatch", async () => {
    const host = setup();
    const token = null as unknown as DefinitionRef;
    expect(host.provide(token as EventToken<string>).ok).toBe(false);
    expect(host.on(token as EventToken<string>, () => {}).ok).toBe(false);
    expect(host.emit(token as EventToken<string>, "input").ok).toBe(false);
    expect((await host.dispatch(token as GuardToken<string>, "input")).ok).toBe(false);
  });
  it.each([{ timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: Infinity }, { signal: {} }, { signal: Object.create(AbortSignal.prototype) }, { unknown: true }].map((input) => ({ input })))("invalid call options %j never enter the handler", async ({ input }) => {
    const host = setup(); const token = value(defineChain({ name: "input", input: text, output: number })); let calls = 0;
    value(host.provide(token, () => { calls += 1; return { ok: true, value: 1 }; }));
    expect((await host.dispatch(token, "a", input as CallOptions)).ok).toBe(false); expect(calls).toBe(0); expect(host.inspect().activeCalls).toBe(0);
  });
  it("invalid cascade data cannot turn a rejected unload into a cascade", async () => {
    const host = setup(); const service = value(defineService<{ run(input: void): Promise<Result<void>> }>({ name: "dependency", methods: { run: {} } }));
    const installed = value(await host.load([
      { name: "provider", provides: [service], apply(ctx) { return ctx.provide(service, { run: () => Promise.resolve({ ok: true, value: undefined }) }); } },
      { name: "consumer", requires: [service], apply() { return { ok: true, value: undefined }; } },
    ]));
    expect(await host.unload(installed.plugins[0]!, { cascade: "false" } as unknown as { cascade: boolean })).toMatchObject({ ok: false, reason: { code: "invalid-input" } });
    expect(host.inspect().plugins).toHaveLength(2);
  });
  it("malformed manifest arrays and undeclared providers cannot be partially published", async () => {
    const host = setup(); const service = value(defineService<{ run(input: void): Promise<Result<void>> }>({ name: "declared", methods: { run: {} } }));
    const malformed = { name: "bad", requires: {}, apply() { return { ok: true, value: undefined }; } } as unknown as Plugin;
    expect((await host.load([malformed])).ok).toBe(false);
    expect((await host.load([{ name: "undeclared", apply(ctx) { return ctx.provide(service, { run: () => Promise.resolve({ ok: true, value: undefined }) }); } }])).ok).toBe(false);
    expect(host.inspect()).toMatchObject({ effects: 0, activeCalls: 0 });
  });
  it("invalid shadow config does not modify an existing provider", () => {
    const host = setup(); const token = value(defineChain({ name: "shadow", input: text, output: number }));
    expect(host.provide(token, () => ({ ok: true, value: 1 }), { shadow: "false" } as unknown as ProvideOptions).ok).toBe(false);
    expect(host.provide(token, () => ({ ok: true, value: 2 })).ok).toBe(true);
  });
  it("unknown install options cannot queue a mutation", async () => {
    const host = setup();
    expect((await host.load([], { unknown: true } as unknown as { scope?: Context })).ok).toBe(false);
    expect((await host.load([])).ok).toBe(true);
  });
});

describe("resource ownership across scope boundaries", () => {
  it("closing a child cleans its consumer resources held by an outer owner", async () => {
    const host = setup(); const child = value(host.scope({ label: "child" })); let released = 0;
    const token = value(defineService<{ open(input: void): Promise<Result<import("../../index").Disposer>> }>({ name: "scoped-resource", methods: { open: {} } }));
    value(child.provide(token, { open(_input, call) { return Promise.resolve(call.effect(() => { released += 1; return { ok: true, value: undefined }; })); } }));
    const task = value(host.spawn({ label: "outer", async run(call) {
      const bound = value(call.bind(child)); value(await value(bound.use(token)).open(undefined)); return { ok: true, value: undefined };
    } }));
    value(await host.wait(task));
    value(await host.closeScope(child));
    expect(released).toBe(1); expect(host.inspect()).toMatchObject({ state: "open", scopes: 1, effects: 0 });
  });
  it("a creator can close its own child assembly with internal consumers", async () => {
    const host = setup(); let child!: Context;
    const token = value(defineService<{ run(input: void): Promise<Result<void>> }>({ name: "child-service", methods: { run: {} } }));
    value(await host.load([{ name: "creator", provides: [token], apply(ctx) {
      child = value(ctx.scope({ label: "owned" })); value(child.provide(token, { run: () => Promise.resolve({ ok: true, value: undefined }) }));
      return ctx.provide(token, { run: () => Promise.resolve({ ok: true, value: undefined }) });
    } }]));
    value(await host.load([{ name: "dependent", requires: [token], apply() { return { ok: true, value: undefined }; } }], { scope: child }));
    value(child.requestClose()); await flush();
    expect(child.state).toBe("closed"); expect(host.state).toBe("open");
  });
});
