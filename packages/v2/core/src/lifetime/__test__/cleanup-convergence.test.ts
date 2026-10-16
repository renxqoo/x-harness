import { afterEach, describe, expect, it } from "vitest";
import { createHost, defineService } from "../../index";
import type { Context, Disposer, Result, Host } from "../../index";

const roots: Host[] = [];
afterEach(async () => { for (const host of roots.splice(0)) await host.close(); });

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function setup() {
  const host = value(createHost());
  roots.push(host);
  return host;
}

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

const success = (): Result<void> => ({ ok: true, value: undefined });

describe("actual cleanup convergence and scoped close receipts", () => {
  it("a successful disposer cannot release its provider while an unawaited cleanup call still runs", async () => {
    const host = setup();
    const token = value(defineService<{ run(input: void): Promise<Result<void>> }>({ name: "cleanup/unawaited", methods: { run: {} } }));
    const gate = deferred<void>();
    let closed = false;
    value(host.register(token, { async run() { await gate.promise; return success(); } }));
    value(host.addCleanup((call) => { void value(call.context.use(token)).run(undefined); return success(); }));
    const closing = host.close().then((result) => { closed = true; return result; });
    try {
      await flush();
      expect(closed).toBe(false);
      expect(host.inspect()).toMatchObject({ state: "closing", activeCalls: 1, effects: 2 });
    } finally {
      gate.resolve();
      value(await closing);
    }
    expect(host.inspect()).toMatchObject({ state: "closed", activeCalls: 0, effects: 0 });
  });

  it("a throwing disposer still drains its newly created cleanup calls before reporting cleanup failure", async () => {
    const host = setup();
    const token = value(defineService<{ run(input: void): Promise<Result<void>> }>({ name: "cleanup/throwing", methods: { run: {} } }));
    const gate = deferred<void>();
    let closed = false;
    value(host.register(token, { async run() { await gate.promise; return success(); } }));
    value(host.addCleanup((call) => { void value(call.context.use(token)).run(undefined); throw new Error("cleanup"); }));
    const closing = host.close().then((result) => { closed = true; return result; });
    try {
      await flush();
      expect(closed).toBe(false);
      expect(host.inspect().activeCalls).toBe(1);
    } finally {
      gate.resolve();
      expect((await closing).ok).toBe(false);
    }
    expect(host.inspect()).toMatchObject({ state: "close-failed", activeCalls: 0, effects: 2 });
  });

  it("a consumer resource owned outside the closing scope keeps provider resources when its cleanup fails", async () => {
    const host = setup();
    const child = value(host.createScope({ label: "provider-scope" }));
    const token = value(defineService<{ open(input: void): Promise<Result<Disposer>> }>({ name: "cleanup/external-consumer", methods: { open: {} } }));
    let providerAlive = true;
    value(await host.install([{ name: "external-resource-provider", provides: { token }, setup(ctx) {
      value(ctx.addCleanup(() => { providerAlive = false; return success(); }));
      return ctx.register(token, { open(_input, call) { return Promise.resolve(call.effect(() => ({ ok: false, error: { source: "core", code: "cleanup-failed", message: "cleanup rejected" } }))); } });
    } }], { scope: child }));
    const opening = value(host.startTask({ label: "host-consumer", run(call) {
      return value(value(call.bind(child)).use(token)).open(undefined);
    } }));
    value(await host.wait(opening));
    const closed = await host.closeScope(child);
    expect(closed.ok).toBe(false);
    expect(child.scopeState).toBe("close-failed");
    expect(providerAlive).toBe(true);
    expect(host.inspect().effects).toBe(3);
    expect(host.inspect().plugins).toHaveLength(1);
    expect(host.inspect().plugins[0]?.state).toBe("failed");
  });

  it("a later self service remains available to an earlier registered plugin cleanup resource", async () => {
    const host = setup();
    const token = value(defineService<{ run(input: void): Promise<Result<void>> }>({ name: "cleanup/self-service", methods: { run: {} } }));
    let cleaned = false;
    value(await host.install([{ name: "self-cleanup", provides: { token }, setup(ctx) {
      value(ctx.addCleanup(async (call) => {
        const result = await value(call.context.use(token)).run(undefined);
        if (!result.ok) return result;
        cleaned = true;
        return success();
      }));
      return ctx.register(token, { run() { return Promise.resolve(success()); } });
    } }]));
    value(await host.close());
    expect(cleaned).toBe(true);
  });

  it("subtree close reports every installed plugin with its actual scope and excludes copied scope owners", async () => {
    const host = setup();
    const outer = value(host.createScope({ label: "outer" }));
    const inner = value(outer.createScope({ label: "inner" }));
    let owned!: Context;
    const first = value(await host.install([{ name: "outer-plugin", setup(ctx) { owned = value(ctx.createScope({ label: "plugin-owned" })); return success(); } }], { scope: outer })).plugins[0]!;
    const second = value(await host.install([{ name: "inner-plugin", setup: () => success() }], { scope: inner })).plugins[0]!;
    const result = value(await host.closeScope(outer));
    expect(result.stoppedPlugins).toEqual([first, second]);
    expect(owned.scopeState).toBe("closed");
    expect(host.inspect().plugins).toHaveLength(0);
  });

  it("scope close releasedEffects does not count an unrelated root release happening during cleanup", async () => {
    const host = setup();
    const child = value(host.createScope({ label: "child" }));
    const gate = deferred<Result<void>>();
    const unrelated = value(host.addCleanup(success));
    value(child.addCleanup(() => gate.promise));
    const closing = host.closeScope(child);
    await flush();
    value(await unrelated());
    gate.resolve(success());
    expect(value(await closing).releasedEffects).toBe(1);
  });

  it("scope close releasedEffects remains accurate when unrelated root resources are created during cleanup", async () => {
    const host = setup();
    const child = value(host.createScope({ label: "child" }));
    const gate = deferred<Result<void>>();
    value(child.addCleanup(() => gate.promise));
    const closing = host.closeScope(child);
    await flush();
    value(host.addCleanup(success));
    gate.resolve(success());
    expect(value(await closing).releasedEffects).toBe(1);
    expect(host.inspect().effects).toBe(1);
  });

  it("a closing provider scope counts a successful outside-owned consumer cleanup in its receipt", async () => {
    const host = setup();
    const child = value(host.createScope({ label: "provider-scope" }));
    const token = value(defineService<{ open(input: void): Promise<Result<Disposer>> }>({ name: "cleanup/receipt", methods: { open: {} } }));
    value(await host.install([{ name: "receipt-provider", provides: { token }, setup(ctx) {
      return ctx.register(token, { open(_input, call) { return Promise.resolve(call.effect(success)); } });
    } }], { scope: child }));
    const opening = value(host.startTask({ label: "host-consumer", run(call) { return value(value(call.bind(child)).use(token)).open(undefined); } }));
    value(await host.wait(opening));
    expect(value(await host.closeScope(child)).releasedEffects).toBe(2);
    expect(host.inspect().effects).toBe(0);
  });
});
