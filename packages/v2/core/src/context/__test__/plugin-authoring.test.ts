import { afterEach, describe, expect, it } from "vitest";
import { defineChain, defineEvent, defineGuard, definePlugin, defineService } from "../../index";
import type { Disposer, PluginContext, Result, Host } from "../../index";
import { clock, deferred, flush, root, text, value } from "../../__test__/helpers";

const roots: Host[] = [];
afterEach(async () => { for (const host of roots.splice(0)) await host.close(); });
const host = (options?: Parameters<typeof root>[0]) => { const created = root(options); roots.push(created); return created; };
const endpoint = (name: string) => value(defineService<{ run(input: string): Promise<Result<string>> }>({ name, methods: { run: {} } }));

function provider(token: ReturnType<typeof endpoint>) {
  return definePlugin({ name: "provider", provides: { token }, setup(ctx) {
    return ctx.service({ token: { async run(input) { return { ok: true, value: input }; } } });
  } });
}

describe("typed plugin declarations", () => {
  it("declared dependencies are bound to the current request and revoked after it ends", async () => {
    const app = host();
    const source = endpoint("authoring/source");
    const target = endpoint("authoring/target");
    let saved!: { run(input: string): Promise<Result<string>> };
    value(await app.install([provider(source), definePlugin({ name: "consumer", requires: { source }, provides: { target }, setup(ctx) {
      return ctx.service({ target: { async run(input, call) {
        saved = call.deps.source;
        return call.deps.source.run(input);
      } } });
    } })]));
    expect(value(await value(app.use(target)).run("hello"))).toBe("hello");
    expect(await saved.run("expired")).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    expect(app.inspect()).toMatchObject({ activeCalls: 0, serviceLeases: 1 });
  });

  it("setup dependencies expire after activation without losing service request dependencies", async () => {
    const app = host();
    const source = endpoint("authoring/setup-source");
    let saved!: { run(input: string): Promise<Result<string>> };
    value(await app.install([provider(source), definePlugin({ name: "consumer", requires: { source }, async setup(ctx) {
      saved = ctx.deps.source;
      return saved.run("setup");
    } })]));
    expect(await saved.run("expired")).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    expect(app.inspect().serviceLeases).toBe(0);
  });

  it("an absent optional dependency stays absent after a provider is installed", async () => {
    const app = host();
    const source = endpoint("authoring/optional");
    const target = endpoint("authoring/optional-target");
    value(await app.install([definePlugin({ name: "consumer", optional: { source }, provides: { target }, setup(ctx) {
      expect(ctx.deps.source).toBeUndefined();
      return ctx.service({ target: { async run(input, call) {
        return call.deps.source ? call.deps.source.run(input) : { ok: true, value: "absent" };
      } } });
    } })]));
    value(await app.install([provider(source)]));
    expect(value(await value(app.use(target)).run("input"))).toBe("absent");
  });

  it("an available optional dependency is typed and receives request cancellation", async () => {
    const app = host();
    const source = endpoint("authoring/optional-present");
    const target = endpoint("authoring/optional-present-target");
    value(await app.install([provider(source), definePlugin({ name: "consumer", optional: { source }, provides: { target }, setup(ctx) {
      return ctx.service({ target: { async run(input, call) {
        return call.deps.source ? call.deps.source.run(input) : { ok: true, value: "absent" };
      } } });
    } })]));
    expect(value(await value(app.use(target)).run("present"))).toBe("present");
  });

  it("a declaration snapshot is not changed by later mutation of its input maps", async () => {
    const app = host();
    const source = endpoint("authoring/snapshot");
    const requires = { source };
    const plugin = definePlugin({ name: "consumer", requires, async setup(ctx) { return ctx.deps.source.run("snapshot"); } });
    requires.source = endpoint("authoring/replaced");
    value(await app.install([provider(source), plugin]));
  });

  it("service receipts retain individual revocation with dependency protection", async () => {
    const app = host();
    const source = endpoint("authoring/revoke");
    let revoke!: Disposer;
    const installed = value(await app.install([definePlugin({ name: "provider", provides: { source }, setup(ctx) {
      const provided = ctx.service({ source: { async run(input) { return { ok: true, value: input }; } } });
      if (!provided.ok) return provided;
      revoke = provided.value.source;
      return { ok: true, value: undefined };
    } }), definePlugin({ name: "consumer", requires: { source }, setup() { return { ok: true, value: undefined }; } })]));
    expect(await revoke()).toMatchObject({ ok: false, error: { code: "plugin-in-use" } });
    value(await app.uninstall(installed.plugins[1]!));
    value(await revoke());
    expect(app.use(source).ok).toBe(false);
  });

  it("chains preserve continuation behavior and guards dispatch from the current request", async () => {
    const app = host();
    const chain = value(defineChain({ name: "authoring/chain", input: text, output: text }));
    const guard = value(defineGuard({ name: "authoring/guard", input: text }));
    const target = endpoint("authoring/dispatch-target");
    value(await app.install([
      definePlugin({ name: "extensions", provides: { chain, guard }, setup(ctx) {
        const provided = ctx.handle("chain", (input) => ({ ok: true, value: input }));
        if (!provided.ok) return provided;
        return ctx.guard("guard", () => ({ ok: true, value: { kind: "allow" } }));
      } }),
      definePlugin({ name: "middleware", requires: { chain }, setup(ctx) {
        return ctx.middleware("chain", (input, next) => next(input + "!").finally(() => undefined));
      } }),
      definePlugin({ name: "consumer", requires: { chain, guard }, provides: { target }, setup(ctx) {
        return ctx.service({ target: { async run(input, call) {
          const allowed = await call.dispatch("guard", input);
          if (!allowed.ok) return allowed;
          return call.dispatch("chain", input);
        } } });
      } }),
    ]));
    expect(value(await value(app.use(target)).run("hello"))).toBe("hello!");
  });

  it("events use declared names and keep publishing permission with their provider", async () => {
    const app = host();
    const changed = value(defineEvent({ name: "authoring/event", payload: text }));
    const received: string[] = [];
    let publish!: (input: string) => unknown;
    value(await app.install([
      definePlugin({ name: "publisher", provides: { changed }, setup(ctx) {
        publish = (input) => ctx.emit("changed", input);
        return { ok: true as const, value: undefined };
      } }),
      definePlugin({ name: "listener", requires: { changed }, setup(ctx) {
        return ctx.on("changed", async (input) => { received.push(input); });
      } }),
    ]));
    expect(publish("changed")).toMatchObject({ ok: true });
    await flush();
    expect(received).toEqual(["changed"]);
  });

  it("invalid definitions and array manifests are rejected without running setup", async () => {
    const app = host();
    let called = false;
    for (const raw of [null, { name: "bad", setup: 1 }, { name: "bad", requires: [], setup() { called = true; return { ok: true }; } }]) {
      expect((await app.install([definePlugin(raw as never)])).ok).toBe(false);
    }
    expect(called).toBe(false);
    expect(app.inspect()).toMatchObject({ plugins: [], effects: 0 });
  });

  it("dynamic service maps compile and register without losing runtime completeness checks", async () => {
    const app = host(); const source = endpoint("authoring/dynamic");
    const provides: Record<string, typeof source> = { source };
    const implementations = Object.fromEntries(Object.keys(provides).map((name) => [name, { async run(input: string) { return { ok: true as const, value: input }; } }]));
    const installed = value(await app.install([definePlugin({ name: "dynamic", provides, setup(ctx) { return ctx.service(implementations); } })]));
    expect(value(await value(app.use(source)).run("dynamic"))).toBe("dynamic");
    value(await app.uninstall(installed.plugins[0]!));
    const malformed = { ...implementations, extra: implementations.source! };
    expect((await app.install([definePlugin({ name: "extra", provides, setup(ctx) { return ctx.service(malformed); } })])).ok).toBe(false);
    expect(app.use(source).ok).toBe(false); value(await app.close());
  });

  it("unknown and missing implementations cannot be partially published", async () => {
    const app = host();
    const source = endpoint("authoring/malformed");
    for (const implementations of [{}, { source: {}, extra: {} }, null]) {
      const plugin = definePlugin({ name: "bad", provides: { source }, setup(ctx) { return ctx.service(implementations as never); } });
      expect((await app.install([plugin])).ok).toBe(false);
      expect(app.use(source).ok).toBe(false);
    }
  });

  it("expired plugin entry points and unknown extension names return failures", async () => {
    const app = host();
    const changed = value(defineEvent({ name: "authoring/expired", payload: text }));
    let saved!: PluginContext<{ provides: { changed: typeof changed } }>;
    value(await app.install([definePlugin({ name: "provider", provides: { changed }, setup(ctx) { saved = ctx; return { ok: true as const, value: undefined }; } })]));
    expect(saved.on("missing" as never, (() => undefined) as never).ok).toBe(false);
    expect(await saved.dispatch("missing" as never, undefined as never)).toMatchObject({ ok: false });
    expect(saved.emit("missing" as never, "input" as never).ok).toBe(false);
    value(await app.close());
    expect(saved.service({}).ok).toBe(false);
  });

  it("plugin configuration belongs to its factory and does not become kernel state", async () => {
    const app = host();
    const target = endpoint("authoring/configuration");
    const configured = (prefix: string) => definePlugin({ name: "configured", provides: { target }, setup(ctx) {
      return ctx.service({ target: { async run(input) { return { ok: true, value: prefix + input }; } } });
    } });
    value(await app.install([configured("hello ")]));
    expect(value(await value(app.use(target)).run("world"))).toBe("hello world");
  });
});

describe("paired resource acquisition", () => {
  it("resources are acquired once and released after their actual users finish", async () => {
    const app = host();
    const target = endpoint("authoring/resource");
    const gate = deferred<Result<string>>();
    let released = 0;
    const installed = value(await app.install([definePlugin({ name: "provider", provides: { target }, async setup(ctx) {
      const acquired = await ctx.resource({ open: () => ({ ok: true, value: "connection" }), close: () => { released += 1; return { ok: true, value: undefined }; } });
      if (!acquired.ok) return acquired;
      return ctx.service({ target: { async run() { return gate.promise; } } });
    } })]));
    const running = value(app.use(target)).run("input");
    await flush();
    const closing = app.uninstall(installed.plugins[0]!);
    await flush();
    expect(released).toBe(0);
    gate.resolve({ ok: true, value: "done" });
    await running;
    value(await closing);
    expect(released).toBe(1);
  });

  it("a timed out acquisition is reclaimed after late success while its owner stays active", async () => {
    const time = clock();
    const app = host({ scheduler: time.scheduler, limits: { callTimeoutMs: 10 } });
    const gate = deferred<Result<number>>();
    let released = 0;
    const acquiring = app.resource({ open: () => gate.promise, close: () => { released += 1; return { ok: true, value: undefined }; } });
    await flush();
    time.advance(10);
    expect(await acquiring).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(app.inspect()).toMatchObject({ state: "open", activeCalls: 1, effects: 1 });
    gate.resolve({ ok: true, value: 7 });
    await flush();
    expect(released).toBe(1);
    expect(app.inspect()).toMatchObject({ state: "open", activeCalls: 0, effects: 0 });
  });

  it("acquisition failures remove their empty records without invoking release", async () => {
    const app = host();
    let released = false;
    expect(await app.resource({ open: () => ({ ok: false, error: "offline" }), close: () => { released = true; return { ok: true, value: undefined }; } })).toEqual({ ok: false, error: "offline" });
    await flush();
    expect(released).toBe(false);
    expect(app.inspect().effects).toBe(0);
  });

  it("resource budgets are reserved before external allocation", async () => {
    const app = host({ limits: { maxEffects: 1 } });
    value(app.addCleanup(() => ({ ok: true, value: undefined })));
    let acquired = false;
    expect((await app.resource({ open: () => { acquired = true; return { ok: true, value: 1 }; }, close: () => ({ ok: true, value: undefined }) })).ok).toBe(false);
    expect(acquired).toBe(false);
  });

  it("acquire dependencies are parented to acquisition and not the setup caller", async () => {
    const app = host();
    const source = endpoint("authoring/acquire-dependency");
    let acquireId: string | undefined;
    let parentId: string | undefined;
    value(app.register(source, { async run(input, call) { parentId = call.parentId; return { ok: true, value: input }; } }));
    value(await app.install([definePlugin({ name: "consumer", requires: { source }, async setup(ctx) {
      return ctx.resource({ open(call) { acquireId = call.id; return call.deps.source.run("acquire"); }, close: () => ({ ok: true, value: undefined }) });
    } })]));
    expect(parentId).toBe(acquireId);
  });

  it("request resources belong to the consumer and retain their cleanup dependency", async () => {
    const app = host();
    const target = endpoint("authoring/consumer-resource");
    let released = 0;
    const installed = value(await app.install([definePlugin({ name: "provider", provides: { target }, setup(ctx) {
      return ctx.service({ target: { async run(input, call) {
        const resource = await call.resource({ open: () => ({ ok: true, value: input }), close: () => { released += 1; return { ok: true, value: undefined }; } });
        return resource;
      } } });
    } })]));
    const consumer = value(app.createScope({ label: "consumer" }));
    expect(value(await value(consumer.use(target)).run("resource"))).toBe("resource");
    expect((await app.uninstall(installed.plugins[0]!)).ok).toBe(false);
    value(await app.closeScope(consumer));
    expect(released).toBe(1);
    value(await app.uninstall(installed.plugins[0]!));
  });

  it("cleanup failure retains the resource record and does not report a clean close", async () => {
    const app = host();
    value(await app.resource({ open: () => ({ ok: true, value: 1 }), close: () => ({ ok: false, error: { source: "core", code: "cleanup-failed", message: "failed" } }) }));
    expect((await app.close()).ok).toBe(false);
    expect(app.inspect()).toMatchObject({ state: "close-failed", effects: 1 });
  });

  it("invalid resource specifications and revoked calls never invoke allocation", async () => {
    const app = host();
    for (const spec of [null, {}, { open: 1, close: 1 }, { open() {}, close() {}, extra: true }]) {
      expect((await app.resource(spec as never)).ok).toBe(false);
    }
    value(await app.close());
    expect((await app.resource({ open: () => ({ ok: true, value: 1 }), close: () => ({ ok: true, value: undefined }) })).ok).toBe(false);
  });
});
