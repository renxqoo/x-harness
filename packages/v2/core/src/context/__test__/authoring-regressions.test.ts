import { afterEach, expect, it } from "vitest";
import { defineEvent, definePlugin, defineService } from "../../index";
import type { Context, Origin, Plugin, PluginContext, Result, Host } from "../../index";
import { deferred, flush, root, text, value } from "../../__test__/helpers";

const roots: Host[] = [];
afterEach(async () => { for (const app of roots.splice(0)) await app.close(); });
const host = (options?: Parameters<typeof root>[0]) => { const app = root(options); roots.push(app); return app; };
const service = (name: string) => value(defineService<{ run(input: string): Promise<Result<string>> }>({ name, methods: { run: {} } }));

it("a saved plugin context observes scope closure instead of its installation snapshot", async () => {
  const app = host();
  let saved!: PluginContext<{}>;
  value(await app.install([definePlugin({ name: "saved", setup(ctx) { saved = ctx; return { ok: true, value: undefined }; } })]));
  expect(saved.scopeState).toBe("open");
  value(await app.close());
  expect(saved.scopeState).toBe("closed");
});

it("hostile extension names never execute string coercion or escape Result boundaries", async () => {
  const app = host();
  const changed = value(defineEvent({ name: "regression/name", payload: text }));
  const target = service("regression/dispatch-name");
  let saved!: PluginContext<{ provides: { changed: typeof changed; target: typeof target } }>;
  let dispatch!: (name: unknown) => Promise<unknown>;
  value(await app.install([definePlugin({ name: "provider", provides: { changed, target }, setup(ctx) {
    saved = ctx;
    return ctx.service({ target: { async run(input, call) {
      dispatch = (name) => call.dispatch(name as never, input as never);
      return { ok: true, value: input };
    } } });
  } })]));
  const poison = { toString() { throw new Error("poison-name"); } };
  expect(saved.on(poison as never, (() => undefined) as never)).toMatchObject({ ok: false });
  expect(await saved.dispatch(poison as never, undefined as never)).toMatchObject({ ok: false });
  expect(saved.emit(poison as never, "input")).toMatchObject({ ok: false });
  value(await value(app.use(target)).run("input"));
  expect(await dispatch(poison)).toMatchObject({ ok: false });
});

it("failed batch provision leaves no first provider and corrected implementations can be provided", async () => {
  const app = host();
  const a = service("regression/provide-a");
  const b = service("regression/provide-b");
  const implementation = { async run(input: string) { return { ok: true as const, value: input }; } };
  value(await app.install([definePlugin({ name: "provider", provides: { a, b }, setup(ctx) {
    expect(ctx.service({ a: implementation, b: {} as never }).ok).toBe(false);
    expect(app.inspect().effects).toBe(0);
    return ctx.service({ a: implementation, b: implementation });
  } })]));
  expect(value(await value(app.use(a)).run("a"))).toBe("a");
  expect(value(await value(app.use(b)).run("b"))).toBe("b");
});

it("batch provider capacity is checked before any provider is registered", async () => {
  const app = host({ limits: { maxEffects: 1 } });
  const a = service("regression/capacity-a");
  const b = service("regression/capacity-b");
  const implementation = { async run(input: string) { return { ok: true as const, value: input }; } };
  const loaded = await app.install([definePlugin({ name: "provider", provides: { a, b }, setup(ctx) {
    const provided = ctx.service({ a: implementation, b: implementation });
    expect(provided).toMatchObject({ ok: false, error: { code: "resource-limit" } });
    expect(app.inspect().effects).toBe(0);
    return provided;
  } })]);
  expect(loaded.ok).toBe(false);
  expect(app.inspect()).toMatchObject({ plugins: [], effects: 0 });
});

it("per-call dependency facades do not consume the durable lease budget under concurrency", async () => {
  const app = host({ limits: { maxServiceLeasesPerOwner: 1 } });
  const source = service("regression/lease-source");
  const target = service("regression/lease-target");
  const firstGate = deferred<void>();
  value(app.register(source, { async run(input) {
    if (input === "first") await firstGate.promise;
    return { ok: true, value: input };
  } }));
  value(await app.install([definePlugin({ name: "consumer", requires: { source }, provides: { target }, setup(ctx) {
    return ctx.service({ target: { async run(input, call) {
      return call.deps.source.run(input);
    } } });
  } })]));
  const bound = value(app.use(target));
  const pending = Array.from({ length: 30 }, () => bound.run("first"));
  await flush();
  firstGate.resolve();
  const concurrent = await Promise.all(pending);
  expect(concurrent.every((result) => result.ok && result.value === "first")).toBe(true);
  expect(app.inspect().serviceLeases).toBe(1);
});

it("consumer resource cleanup preserves resourceOwner across dependency service calls", async () => {
  const app = host();
  const cleanup = service("regression/cleanup");
  const source = service("regression/resource-owner");
  let owner!: Origin;
  let phase = "";
  value(app.register(cleanup, { async run(input, call) { owner = call.resourceOwner; phase = call.phase; return { ok: true, value: input }; } }));
  value(await app.install([definePlugin({ name: "source", requires: { cleanup }, provides: { source }, setup(ctx) {
    return ctx.service({ source: { async run(input, call) {
      return call.resource({
        open: () => ({ ok: true, value: input }),
        async close(resource, closing) {
          const dependency = closing.context.use(cleanup);
          if (!dependency.ok) return dependency;
          const released = await dependency.value.run(resource);
          return released.ok ? { ok: true, value: undefined } : released;
        },
      });
    } } });
  } })]));
  const consumer = value(app.createScope({ label: "consumer" }));
  value(await value(consumer.use(source)).run("resource"));
  value(await app.closeScope(consumer));
  expect(owner.scopeId).toBe(consumer.scopeId);
  expect(phase).toBe("cleanup");
});

it("staging child capabilities remain hidden until the whole transaction commits", async () => {
  for (const succeed of [true, false]) {
    const app = host();
    const token = service("regression/staging-child");
    const gate = deferred<void>();
    let child!: Context;
    const loading = app.install([definePlugin({ name: "parent", provides: { token }, async setup(ctx) {
      const supplied = ctx.service({ token: { async run(input) { return { ok: true, value: input }; } } });
      if (!supplied.ok) return supplied;
      const scope = ctx.createScope({ label: "child" });
      if (!scope.ok) return scope;
      child = scope.value;
      const shadow = child.register(token, { async run() { return { ok: true, value: "child" }; } }, { shadow: true });
      if (!shadow.ok) return shadow;
      await gate.promise;
      return succeed ? { ok: true, value: undefined } : { ok: false, error: "failed" };
    } })]);
    await flush();
    const before = child.use(token);
    gate.resolve();
    const loaded = await loading;
    expect(before.ok).toBe(false);
    expect(loaded.ok).toBe(succeed);
    if (succeed) expect(value(await value(child.use(token)).run("input"))).toBe("child");
    else expect(app.inspect()).toMatchObject({ scopes: 1, plugins: [], effects: 0 });
  }
});

it("failed staging child cleanup keeps the installation degraded and its parent retained", async () => {
  const app = host();
  const loaded = await app.install([definePlugin({ name: "parent", setup(ctx) {
    const scope = ctx.createScope({ label: "child" });
    if (!scope.ok) return scope;
    value(scope.value.addCleanup(() => ({ ok: false, error: { source: "core", code: "cleanup-failed", message: "failed" } })));
    return { ok: false, error: "setup-failed" };
  } })]);
  expect(loaded).toMatchObject({ ok: false, error: { code: "activation-unsettled" } });
  expect(app.inspect()).toMatchObject({ degraded: true, plugins: [{ state: "failed" }], effects: 1 });
});

it("stable topological installation preserves input priority when ready nodes enter the heap", async () => {
  const app = host();
  const order: string[] = [];
  const tokens = Object.fromEntries(["a", "b", "c", "d", "e", "f", "g", "h"].map((name) => [name, service(`regression/order-${name}`)]));
  const create = (name: string, upstream: string[]): Plugin => ({
    name,
    requires: Object.fromEntries(upstream.map((dependency, index) => [`dependency${index}`, tokens[dependency]!])),
    provides: { owned: tokens[name]! },
    setup(ctx) { order.push(name); return ctx.register(tokens[name]!, { async run(input) { return { ok: true, value: input }; } }); },
  });
  value(await app.install([create("a", ["b"]), create("b", ["d"]), create("c", []), create("d", []), create("e", ["c"]), create("f", []), create("g", ["a"]), create("h", ["b"])]));
  expect(order).toEqual(["c", "d", "b", "a", "e", "f", "g", "h"]);
});

it("late microtasks cannot add children after the parent has begun joining actual work", async () => {
  const app = host();
  let late: Result<unknown> | undefined;
  let effect: Result<unknown> | undefined;
  let entered = false;
  const parent = value(app.startTask({ label: "parent", run(call) {
    queueMicrotask(() => queueMicrotask(() => {
      late = call.spawn({ label: "escaped", run() { entered = true; return { ok: true, value: undefined }; } });
      effect = call.effect(() => ({ ok: true, value: undefined }));
    }));
    return { ok: true, value: "parent" };
  } }));
  const outcome = await app.wait(parent);
  await flush();
  expect(outcome).toEqual({ ok: true, value: "parent" });
  expect(late).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(effect).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(entered).toBe(false);
  expect(app.inspect()).toMatchObject({ activeTasks: 0, effects: 0 });
});

it("staging child work cannot mint transaction authorization through spawn or resource", async () => {
  const app = host();
  const gate = deferred<void>();
  let child!: Context;
  let allocated = false;
  const loading = app.install([definePlugin({ name: "parent", async setup(ctx) {
    const scope = ctx.createScope({ label: "child" });
    if (!scope.ok) return scope;
    child = scope.value;
    await gate.promise;
    return { ok: false, error: "failed" };
  } })]);
  await flush();
  const spawned = child.startTask({ label: "outside", run() { allocated = true; return { ok: true, value: undefined }; } });
  const acquired = await child.resource({ open() { allocated = true; return { ok: true, value: 1 }; }, close: () => ({ ok: true, value: undefined }) });
  gate.resolve();
  await loading;
  expect(spawned).toMatchObject({ ok: false, error: { code: "scope-closed" } });
  expect(acquired).toMatchObject({ ok: false, error: { code: "scope-closed" } });
  expect(allocated).toBe(false);
  expect(app.inspect()).toMatchObject({ plugins: [], effects: 0, activeTasks: 0, activeCalls: 0 });
});

it("late acquisition cleanup does not inherit the cancelled activation as its parent", async () => {
  const app = host();
  const cleanup = service("regression/late-cleanup");
  const gate = deferred<Result<string>>();
  let cleaned = 0;
  value(app.register(cleanup, { async run(input, call) {
    cleaned += 1;
    expect(call.phase).toBe("cleanup");
    expect(call.signal.aborted).toBe(false);
    return { ok: true, value: input };
  } }));
  const loading = app.install([definePlugin({ name: "acquirer", requires: { cleanup }, setup(ctx) {
    return ctx.resource({ open: () => gate.promise, async close(resource, closing) {
      const dependency = closing.context.use(cleanup);
      if (!dependency.ok) return dependency;
      const released = await dependency.value.run(resource);
      return released.ok ? { ok: true, value: undefined } : released;
    } });
  } })]);
  await flush();
  const closing = app.close();
  gate.resolve({ ok: true, value: "resource" });
  const loaded = await loading;
  const closed = await closing;
  expect(loaded.ok).toBe(false);
  expect(closed.ok).toBe(true);
  expect(cleaned).toBe(1);
  expect(app.inspect()).toMatchObject({ state: "closed", degraded: false, effects: 0, activeCalls: 0 });
});

it("registration cannot reopen admission when an options descriptor closes its owner", async () => {
  const app = host();
  const token = service("regression/descriptor-close");
  let closing: ReturnType<Host["close"]> | undefined;
  const options = new Proxy({ shadow: false }, { getOwnPropertyDescriptor(target, key) {
    closing = app.close();
    return Reflect.getOwnPropertyDescriptor(target, key);
  } });
  const provided = app.register(token, { async run(input) { return { ok: true, value: input }; } }, options);
  expect(provided).toMatchObject({ ok: false, error: { code: "scope-closed" } });
  await closing;
  expect(app.inspect()).toMatchObject({ state: "closed", effects: 0, serviceLeases: 0, scopes: 0 });
});

it("retired local tokens do not block fixed dependencies in a replacement staging transaction", async () => {
  const app = host();
  const source = service("regression/replacement-source");
  const target = service("regression/replacement-target");
  let stale: { run(input: string): Promise<Result<string>> } | undefined;
  for (const generation of [1, 2, 3]) {
    const installed = value(await app.install([
      definePlugin({ name: "consumer", requires: { source }, provides: { target }, setup(ctx) {
        return ctx.service({ target: { async run(input, call) { return call.deps.source.run(input); } } });
      } }),
      definePlugin({ name: "provider", provides: { source }, setup(ctx) {
        return ctx.service({ source: { async run(input) { return { ok: true, value: `${generation}:${input}` }; } } });
      } }),
      definePlugin({ name: "initializer", requires: { target }, async setup(ctx) {
        expect(value(await ctx.deps.target.run("setup"))).toBe(`${generation}:setup`);
        return { ok: true, value: undefined };
      } }),
    ]));
    if (stale) expect(await stale.run("stale")).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    stale = value(app.use(target));
    expect(value(await stale.run("input"))).toBe(`${generation}:input`);
    const provider = installed.plugins.find((plugin) => plugin.name === "provider")!;
    value(await app.uninstall(provider, { cascade: true }));
    expect(app.inspect()).toMatchObject({ plugins: [], effects: 0, serviceLeases: 0 });
  }
});

it("empty capability batches cannot report success after an options descriptor stops the host", async () => {
  const app = host();
  let receipt: Result<unknown> | undefined;
  const options = new Proxy({ shadow: false }, { getOwnPropertyDescriptor(target, key) {
    void app.close();
    return Reflect.getOwnPropertyDescriptor(target, key);
  } });
  const loaded = await app.install([definePlugin({ name: "empty", setup(ctx) {
    receipt = ctx.service({}, options);
    return receipt;
  } })]);
  expect(loaded.ok).toBe(false);
  expect(receipt).toMatchObject({ ok: false, error: { code: "scope-closed" } });
  value(await app.close());
  expect(app.inspect()).toMatchObject({ state: "closed", effects: 0, activeCalls: 0 });
});
