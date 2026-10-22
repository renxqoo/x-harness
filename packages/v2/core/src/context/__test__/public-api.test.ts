import { afterEach, expect, it } from "vitest";
import * as api from "../../index";
import {
  createHost,
  defineChain,
  defineEvent,
  defineGuard,
  definePlugin,
  defineService,
} from "../../index";
import type { Context, Host, PluginContext, Result } from "../../index";
import { deferred, flush, text, value } from "../../__test__/helpers";

const roots: Host[] = [];

const host = () => {
  const app = value(createHost());
  roots.push(app);
  return app;
};

afterEach(async () => {
  for (const app of roots.splice(0)) await app.close();
});

it("host and plugin contexts expose clear operations without unknown method aliases", async () => {
  const app = host();
  let ctx!: PluginContext<{}>;
  value(
    await app.install([
      definePlugin({
        name: "api",
        setup(context) {
          ctx = context;
          return { ok: true, value: undefined };
        },
      }),
    ]),
  );
  expect(api).not.toHaveProperty("createContext");

  for (const name of ["provide", "effect", "spawn", "scope", "id", "state"])
    expect(ctx).not.toHaveProperty(name);

  for (const name of ["load", "unload", "dispose"]) expect(app).not.toHaveProperty(name);

  for (const name of [
    "service",
    "handle",
    "on",
    "middleware",
    "guard",
    "resource",
    "addCleanup",
    "startTask",
    "createScope",
  ])
    expect(ctx).toHaveProperty(name, expect.any(Function));

  expect(ctx.scopeId).toBe(app.scopeId);
  expect(ctx.scopeState).toBe("open");
  value(await app.close());
  expect(ctx.scopeState).toBe("closed");
});

it("declared events and guards activate without undefined provider implementations", async () => {
  const app = host();
  const changed = value(defineEvent({ name: "api/changed", payload: text }));
  const allowed = value(defineGuard({ name: "api/allowed", input: text }));
  const received: string[] = [];
  let emit!: (input: string) => Result<unknown>;
  const installed = value(
    await app.install([
      definePlugin({
        name: "publisher",
        provides: { changed, allowed },
        setup(ctx) {
          emit = (input) => ctx.emit("changed", input);
          return ctx.guard("allowed", (input) => ({
            ok: true,
            value: input === "yes" ? { kind: "allow" } : { kind: "deny", reason: "rejected" },
          }));
        },
      }),
      definePlugin({
        name: "listener",
        requires: { changed },
        setup(ctx) {
          return ctx.on("changed", async (input) => {
            received.push(input);
          });
        },
      }),
    ]),
  );
  value(emit("hello"));
  await flush();
  expect(received).toEqual(["hello"]);
  expect(value(await app.dispatch(allowed, "yes"))).toEqual({ kind: "allow" });
  expect(value(await app.dispatch(allowed, "no"))).toEqual({ kind: "deny", reason: "rejected" });
  value(await app.uninstall(installed.plugins[0]!, { cascade: true }));
  expect(app.inspect()).toMatchObject({ plugins: [], effects: 0, pendingEvents: 0 });
});

it("automatic declarations are hidden until commit and removed by failed installation", async () => {
  const app = host();
  const changed = value(defineEvent({ name: "api/staged", payload: text }));
  const gate = deferred<Result<void, string>>();
  const installing = app.install([
    definePlugin({ name: "staged", provides: { changed }, setup: () => gate.promise }),
  ]);
  await flush();
  expect(app.on(changed, () => {})).toMatchObject({
    ok: false,
    error: { code: "service-unavailable" },
  });
  gate.resolve({ ok: false, error: "controlled" });
  expect(await installing).toMatchObject({ ok: false, error: { code: "activation-failed" } });
  expect(app.inspect()).toMatchObject({ effects: 0, plugins: [], degraded: false });
  value(
    await app.install([
      definePlugin({
        name: "replacement",
        provides: { changed },
        setup: () => ({ ok: true, value: undefined }),
      }),
    ]),
  );
  value(app.on(changed, () => {}));
});

it("automatic declarations cannot bypass resource capacity or execute setup after rejection", async () => {
  const app = value(createHost({ limits: { maxEffects: 1 } }));
  roots.push(app);
  const a = value(defineEvent({ name: "api/capacity-a", payload: text }));
  const b = value(defineGuard({ name: "api/capacity-b", input: text }));
  let entered = false;
  const installed = await app.install([
    definePlugin({
      name: "too-many",
      provides: { a, b },
      setup() {
        entered = true;
        return { ok: true, value: undefined };
      },
    }),
  ]);
  expect(installed.ok).toBe(false);
  expect(entered).toBe(false);
  expect(app.inspect()).toMatchObject({ effects: 0, plugins: [], degraded: false });
});

it("event dependencies do not grant emission permission through either context facade", async () => {
  const app = host();
  const changed = value(defineEvent({ name: "api/permission", payload: text }));
  let publish!: (name: unknown, payload: unknown) => Result<unknown>;
  value(
    await app.install([
      definePlugin({
        name: "publisher",
        provides: { changed },
        setup: () => ({ ok: true, value: undefined }),
      }),
      definePlugin({
        name: "listener",
        requires: { changed },
        setup(ctx) {
          publish = (name, payload) => ctx.emit(name as never, payload as never);
          return ctx.on("changed", () => {});
        },
      }),
      {
        name: "native-listener",
        requires: { changed },
        setup(ctx) {
          expect(ctx.emit(changed, "denied")).toMatchObject({
            ok: false,
            error: { code: "undeclared-dependency" },
          });
          return { ok: true, value: undefined };
        },
      },
    ]),
  );
  expect(publish("changed", "denied")).toMatchObject({
    ok: false,
    error: { code: "undeclared-dependency" },
  });
});

it("handler registration rejects wrong extension kinds in native and typed contexts", async () => {
  const app = host();
  const changed = value(defineEvent({ name: "api/kinds-event", payload: text }));
  const chain = value(defineChain({ name: "api/kinds-chain", input: text, output: text }));
  const allowed = value(defineGuard({ name: "api/kinds-guard", input: text }));
  value(app.register(changed));
  value(app.register(chain, (input) => ({ ok: true, value: input })));
  value(app.register(allowed));
  const snapshot = app.inspect();
  expect(app.on(chain as never, () => {})).toMatchObject({
    ok: false,
    error: { code: "invalid-input" },
  });
  expect(app.middleware(changed as never, (() => {}) as never).ok).toBe(false);
  expect(app.guard(changed as never, (() => {}) as never).ok).toBe(false);
  expect(app.handle(changed as never, (() => {}) as never).ok).toBe(false);
  expect(app.inspect().effects).toBe(snapshot.effects);
  value(
    await app.install([
      definePlugin({
        name: "wrong-kinds",
        requires: { changed, chain, allowed },
        setup(ctx) {
          expect(ctx.on("chain" as never, (() => {}) as never).ok).toBe(false);
          expect(ctx.middleware("changed" as never, (() => {}) as never).ok).toBe(false);
          expect(ctx.guard("changed" as never, (() => {}) as never).ok).toBe(false);
          expect(ctx.handle("chain" as never, (() => {}) as never).ok).toBe(false);
          return { ok: true, value: undefined };
        },
      }),
    ]),
  );
});

it("service batches reject chain and event implementations while handle provides the terminal", async () => {
  const app = host();
  const chain = value(defineChain({ name: "api/terminal", input: text, output: text }));
  const changed = value(defineEvent({ name: "api/service-event", payload: text }));
  value(
    await app.install([
      definePlugin({
        name: "provider",
        provides: { chain, changed },
        setup(ctx) {
          expect(ctx.service({ chain: () => ({ ok: true, value: "bad" }) } as never).ok).toBe(
            false,
          );
          expect(ctx.service({ changed: undefined } as never).ok).toBe(false);
          return ctx.handle("chain", (input) => ({ ok: true, value: input }));
        },
      }),
    ]),
  );
  expect(value(await app.dispatch(chain, "hello"))).toBe("hello");
});

it("calls retain effect and spawn while context resources use open and close", async () => {
  const app = host();
  const endpoint = value(
    defineService<{ run(input: string): Promise<Result<string>> }>({
      name: "api/call",
      methods: { run: {} },
    }),
  );
  let closed = 0;
  let cleanup = 0;
  value(
    await app.install([
      definePlugin({
        name: "calls",
        provides: { endpoint },
        async setup(ctx) {
          const opened = await ctx.resource({
            open: () => ({ ok: true, value: 1 }),
            close() {
              closed += 1;
              return { ok: true, value: undefined };
            },
          });

          if (!opened.ok) return opened;

          value(ctx.addCleanup(() => ({ ok: true, value: undefined })));
          value(ctx.startTask({ label: "startup", run: () => ({ ok: true, value: undefined }) }));
          return ctx.service({
            endpoint: {
              async run(input, call) {
                expect(call).not.toHaveProperty("addCleanup");
                expect(call).not.toHaveProperty("startTask");
                const effect = call.effect(() => {
                  cleanup += 1;
                  return { ok: true, value: undefined };
                });

                if (!effect.ok) return effect;

                const spawned = call.spawn({
                  label: "child",
                  run: () => ({ ok: true, value: input }),
                });
                return spawned.ok ? call.wait(spawned.value) : spawned;
              },
            },
          });
        },
      }),
    ]),
  );
  expect(value(await value(app.use(endpoint)).run("kept"))).toBe("kept");
  value(await app.close());
  expect(closed).toBe(1);
  expect(cleanup).toBe(1);
});

it("obsolete resource fields and Result reason never become successful operations", async () => {
  const app = host();
  let entered = false;
  const invalid = await app.resource({
    acquire() {
      entered = true;
      return { ok: true, value: 1 };
    },
    release: () => ({ ok: true, value: undefined }),
  } as never);
  expect(invalid.ok).toBe(false);
  expect(entered).toBe(false);
  const token = value(
    defineService<{ run(input: string): Promise<Result<string, string>> }>({
      name: "api/result",
      methods: { run: {} },
    }),
  );
  value(app.register(token, { run: () => Promise.resolve({ ok: false, reason: "bad" } as never) }));
  expect(await value(app.use(token)).run("input")).toMatchObject({
    ok: false,
    error: { code: "invalid-result" },
  });
  expect(app.inspect().activeCalls).toBe(0);
});

it("closed contexts reject every new registration path without retaining a handler", async () => {
  const app = host();
  const chain = value(defineChain({ name: "api/closed-chain", input: text, output: text }));
  const event = value(defineEvent({ name: "api/closed-event", payload: text }));
  const guard = value(defineGuard({ name: "api/closed-guard", input: text }));
  const child: Context = value(app.createScope({ label: "child" }));
  value(await app.closeScope(child));

  for (const receipt of [
    child.handle(chain, (input) => ({ ok: true, value: input })),
    child.on(event, () => {}),
    child.middleware(chain, (input, next) => next(input)),
    child.guard(guard, () => ({ ok: true, value: { kind: "allow" } })),
  ]) {
    expect(receipt).toMatchObject({ ok: false, error: { code: "scope-closed" } });
  }

  expect(app.inspect()).toMatchObject({ scopes: 1, effects: 0 });
});
