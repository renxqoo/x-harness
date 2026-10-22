import { afterEach, expect, it } from "vitest";
import { definePlugin, defineService } from "../../index";
import type { Context, Plugin, Result, Host } from "../../index";
import { deferred, flush, root, value } from "../../__test__/helpers";

const roots: Host[] = [];
afterEach(async () => {
  for (const app of roots.splice(0)) await app.close();
});

const host = (options?: Parameters<typeof root>[0]) => {
  const app = root(options);
  roots.push(app);
  return app;
};

const service = (name: string) =>
  value(
    defineService<{ run(input: string): Promise<Result<string>> }>({ name, methods: { run: {} } }),
  );

it("staging child capabilities remain hidden until the whole transaction commits", async () => {
  for (const succeed of [true, false]) {
    const app = host();
    const token = service("regression/staging-child");
    const gate = deferred<void>();
    let child!: Context;
    const loading = app.install([
      definePlugin({
        name: "parent",
        provides: { token },
        async setup(ctx) {
          const supplied = ctx.service({
            token: {
              async run(input) {
                return { ok: true, value: input };
              },
            },
          });

          if (!supplied.ok) return supplied;

          const scope = ctx.createScope({ label: "child" });

          if (!scope.ok) return scope;

          child = scope.value;
          const shadow = child.register(
            token,
            {
              async run() {
                return { ok: true, value: "child" };
              },
            },
            { shadow: true },
          );

          if (!shadow.ok) return shadow;

          await gate.promise;
          return succeed ? { ok: true, value: undefined } : { ok: false, error: "failed" };
        },
      }),
    ]);
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
  const loaded = await app.install([
    definePlugin({
      name: "parent",
      setup(ctx) {
        const scope = ctx.createScope({ label: "child" });

        if (!scope.ok) return scope;

        value(
          scope.value.addCleanup(() => ({
            ok: false,
            error: { source: "core", code: "cleanup-failed", message: "failed" },
          })),
        );
        return { ok: false, error: "setup-failed" };
      },
    }),
  ]);
  expect(loaded).toMatchObject({ ok: false, error: { code: "activation-unsettled" } });
  expect(app.inspect()).toMatchObject({
    degraded: true,
    plugins: [{ state: "failed" }],
    effects: 1,
  });
});

it("stable topological installation preserves input priority when ready nodes enter the heap", async () => {
  const app = host();
  const order: string[] = [];
  const tokens = Object.fromEntries(
    ["a", "b", "c", "d", "e", "f", "g", "h"].map((name) => [
      name,
      service(`regression/order-${name}`),
    ]),
  );

  const create = (name: string, upstream: string[]): Plugin => ({
    name,
    requires: Object.fromEntries(
      upstream.map((dependency, index) => [`dependency${index}`, tokens[dependency]!]),
    ),
    provides: { owned: tokens[name]! },
    setup(ctx) {
      order.push(name);
      return ctx.register(tokens[name]!, {
        async run(input) {
          return { ok: true, value: input };
        },
      });
    },
  });

  value(
    await app.install([
      create("a", ["b"]),
      create("b", ["d"]),
      create("c", []),
      create("d", []),
      create("e", ["c"]),
      create("f", []),
      create("g", ["a"]),
      create("h", ["b"]),
    ]),
  );
  expect(order).toEqual(["c", "d", "b", "a", "e", "f", "g", "h"]);
});

it("staging child work cannot mint transaction authorization through spawn or resource", async () => {
  const app = host();
  const gate = deferred<void>();
  let child!: Context;
  let allocated = false;
  const loading = app.install([
    definePlugin({
      name: "parent",
      async setup(ctx) {
        const scope = ctx.createScope({ label: "child" });

        if (!scope.ok) return scope;

        child = scope.value;
        await gate.promise;
        return { ok: false, error: "failed" };
      },
    }),
  ]);
  await flush();
  const spawned = child.startTask({
    label: "outside",
    run() {
      allocated = true;
      return { ok: true, value: undefined };
    },
  });
  const acquired = await child.resource({
    open() {
      allocated = true;
      return { ok: true, value: 1 };
    },
    close: () => ({ ok: true, value: undefined }),
  });
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
  value(
    app.register(cleanup, {
      async run(input, call) {
        cleaned += 1;
        expect(call.phase).toBe("cleanup");
        expect(call.signal.aborted).toBe(false);
        return { ok: true, value: input };
      },
    }),
  );
  const loading = app.install([
    definePlugin({
      name: "acquirer",
      requires: { cleanup },
      setup(ctx) {
        return ctx.resource({
          open: () => gate.promise,
          async close(resource, closing) {
            const dependency = closing.context.use(cleanup);

            if (!dependency.ok) return dependency;

            const released = await dependency.value.run(resource);
            return released.ok ? { ok: true, value: undefined } : released;
          },
        });
      },
    }),
  ]);
  await flush();
  const closing = app.close();
  gate.resolve({ ok: true, value: "resource" });
  const loaded = await loading;
  const closed = await closing;
  expect(loaded.ok).toBe(false);
  expect(closed.ok).toBe(true);
  expect(cleaned).toBe(1);
  expect(app.inspect()).toMatchObject({
    state: "closed",
    degraded: false,
    effects: 0,
    activeCalls: 0,
  });
});

it("retired local tokens do not block fixed dependencies in a replacement staging transaction", async () => {
  const app = host();
  const source = service("regression/replacement-source");
  const target = service("regression/replacement-target");
  let stale: { run(input: string): Promise<Result<string>> } | undefined;

  for (const generation of [1, 2, 3]) {
    const installed = value(
      await app.install([
        definePlugin({
          name: "consumer",
          requires: { source },
          provides: { target },
          setup(ctx) {
            return ctx.service({
              target: {
                async run(input, call) {
                  return call.deps.source.run(input);
                },
              },
            });
          },
        }),
        definePlugin({
          name: "provider",
          provides: { source },
          setup(ctx) {
            return ctx.service({
              source: {
                async run(input) {
                  return { ok: true, value: `${generation}:${input}` };
                },
              },
            });
          },
        }),
        definePlugin({
          name: "initializer",
          requires: { target },
          async setup(ctx) {
            expect(value(await ctx.deps.target.run("setup"))).toBe(`${generation}:setup`);
            return { ok: true, value: undefined };
          },
        }),
      ]),
    );

    if (stale)
      expect(await stale.run("stale")).toMatchObject({
        ok: false,
        error: { code: "service-unavailable" },
      });

    stale = value(app.use(target));
    expect(value(await stale.run("input"))).toBe(`${generation}:input`);
    const provider = installed.plugins.find((plugin) => plugin.name === "provider")!;
    value(await app.uninstall(provider, { cascade: true }));
    expect(app.inspect()).toMatchObject({ plugins: [], effects: 0, serviceLeases: 0 });
  }
});
