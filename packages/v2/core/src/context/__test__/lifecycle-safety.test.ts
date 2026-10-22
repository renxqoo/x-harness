import { afterEach, describe, expect, it } from "vitest";
import { defineService } from "../../index";
import type { Context, Result, Host, TaskHandle } from "../../index";
import { clock, deferred, flush, root, value } from "../../__test__/helpers";

const roots: Host[] = [];
afterEach(async () => {
  for (const item of roots.splice(0)) await item.close();
});

const setup = (options?: Parameters<typeof root>[0]) => {
  const item = root(options);
  roots.push(item);
  return item;
};

const service = (name: string) =>
  value(
    defineService<{ release(input: void): Promise<Result<void>> }>({
      name,
      methods: { release: {} },
    }),
  );

describe("resource dependencies and lifecycle budgets", () => {
  it("manual provider removal cannot break cleanup dependencies of its own owner", async () => {
    const host = setup();
    const token = service("same-owner");
    let releases = 0;
    const off = value(
      host.register(token, {
        release: () => {
          releases += 1;
          return Promise.resolve({ ok: true, value: undefined });
        },
      }),
    );
    value(
      host.addCleanup(async (call) => {
        const dependency = call.context.use(token);

        if (!dependency.ok) return dependency;

        return dependency.value.release(undefined);
      }),
    );
    expect(await off()).toMatchObject({ ok: false, error: { code: "plugin-in-use" } });
    expect(host.inspect().effects).toBe(2);
    value(await host.close());
    expect(releases).toBe(1);
    expect(host.inspect().effects).toBe(0);
  });
  it("a refused provider removal can be retried after its cleanup dependents release", async () => {
    const host = setup();
    const token = service("retry-off");
    const off = value(
      host.register(token, { release: () => Promise.resolve({ ok: true, value: undefined }) }),
    );
    const resourceOff = value(host.addCleanup(() => ({ ok: true, value: undefined })));
    expect((await off()).ok).toBe(false);
    value(await resourceOff());
    value(await off());
    expect(host.inspect().effects).toBe(0);
  });
  it("cleanup cannot acquire a service registered after its dependency snapshot", async () => {
    const host = setup();
    const token = service("late-provider");
    value(
      host.addCleanup((call) => {
        expect(call.context.use(token)).toMatchObject({
          ok: false,
          error: { code: "undeclared-dependency" },
        });
        return { ok: true, value: undefined };
      }),
    );
    value(host.register(token, { release: () => Promise.resolve({ ok: true, value: undefined }) }));
    value(await host.close());
  });
  it("cleanup bind retains fixed self dependencies across nested service calls", async () => {
    const host = setup();
    const helper = service("helper");
    const entry = service("entry");
    let released = 0;
    value(
      host.register(helper, {
        release: () => {
          released += 1;
          return Promise.resolve({ ok: true, value: undefined });
        },
      }),
    );
    value(
      host.register(entry, {
        async release(_input, call) {
          const bound = call.bind(host);

          if (!bound.ok) return bound;

          const dependency = bound.value.use(helper);

          if (!dependency.ok) return dependency;

          return dependency.value.release(undefined);
        },
      }),
    );
    value(
      host.addCleanup(async (call) => {
        const dependency = call.context.use(entry);

        if (!dependency.ok) return dependency;

        return dependency.value.release(undefined);
      }),
    );
    value(await host.close());
    expect(released).toBe(1);
    expect(host.inspect().serviceLeases).toBe(0);
  });
  it("a consumer-owned empty child scope does not obstruct cascade unload", async () => {
    const host = setup();
    const token = service("cascade");
    let child!: Context;
    const report = value(
      await host.install([
        {
          name: "provider",
          provides: { token },
          setup(ctx) {
            return ctx.register(token, {
              release: () => Promise.resolve({ ok: true, value: undefined }),
            });
          },
        },
        {
          name: "consumer",
          requires: { token },
          setup(ctx) {
            child = value(ctx.createScope({ label: "owned-child" }));
            return { ok: true, value: undefined };
          },
        },
      ]),
    );
    const closed = value(await host.uninstall(report.plugins[0]!, { cascade: true }));
    expect(child.scopeState).toBe("closed");
    expect(host.inspect().plugins).toHaveLength(0);
    expect(closed.stoppedPlugins.map((plugin) => plugin.name).sort()).toEqual([
      "consumer",
      "provider",
    ]);
    expect(host.inspect()).toMatchObject({ scopes: 1, effects: 0 });
  });
  it("nested owned-scope cleanup dependencies also participate in cascade unload", async () => {
    const host = setup();
    const token = service("nested-cascade");
    let released = false;
    const report = value(
      await host.install([
        {
          name: "provider",
          provides: { token },
          setup(ctx) {
            return ctx.register(token, {
              release: () => {
                released = true;
                return Promise.resolve({ ok: true, value: undefined });
              },
            });
          },
        },
        {
          name: "consumer",
          requires: { token },
          setup(ctx) {
            const nested = value(
              value(ctx.createScope({ label: "child" })).createScope({ label: "nested" }),
            );
            value(
              nested.addCleanup(async (call) => {
                const dependency = call.context.use(token);

                if (!dependency.ok) return dependency;

                return dependency.value.release(undefined);
              }),
            );
            return { ok: true, value: undefined };
          },
        },
      ]),
    );
    value(await host.uninstall(report.plugins[0]!, { cascade: true }));
    expect(released).toBe(true);
    expect(host.inspect()).toMatchObject({ scopes: 1, effects: 0 });
  });
  it("a synchronous disposer exceeding its deadline cannot publish a successful close receipt", async () => {
    const time = clock();
    const host = setup({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } });
    value(
      host.addCleanup(() => {
        time.jump(11);
        return { ok: true, value: undefined };
      }),
    );
    expect(await host.close()).toMatchObject({ ok: false, error: { code: "close-incomplete" } });
    expect(host.inspect()).toMatchObject({ state: "closed", effects: 0, scopes: 0 });
    expect(time.timers.size).toBe(0);
  });
  it("plugin unload checks its fixed deadline even when timers have not executed", async () => {
    const time = clock();
    const host = setup({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } });
    const report = value(
      await host.install([
        {
          name: "late-cleanup",
          setup(ctx) {
            return ctx.addCleanup(() => {
              time.jump(11);
              return { ok: true, value: undefined };
            });
          },
        },
      ]),
    );
    expect(await host.uninstall(report.plugins[0]!)).toMatchObject({
      ok: false,
      error: { code: "close-incomplete" },
    });
    expect(host.inspect().plugins).toHaveLength(0);
    expect(time.timers.size).toBe(0);
  });
  it("global effect limits reject allocation and recover capacity after release", async () => {
    const host = setup({ limits: { maxEffects: 2 } });
    const off = value(host.addCleanup(() => ({ ok: true, value: undefined })));
    value(host.addCleanup(() => ({ ok: true, value: undefined })));
    expect(host.addCleanup(() => ({ ok: true, value: undefined }))).toMatchObject({
      ok: false,
      error: { code: "resource-limit" },
    });
    value(await off());
    value(host.addCleanup(() => ({ ok: true, value: undefined })));
    expect(host.inspect().effects).toBe(2);
  });
  it("global service lease limits count cached facades once and recover on scope close", async () => {
    const host = setup({ limits: { maxServiceLeases: 1 } });
    const token = service("leases");
    value(host.register(token, { release: () => Promise.resolve({ ok: true, value: undefined }) }));
    const child = value(host.createScope({ label: "consumer" }));
    expect(value(child.use(token))).toBe(value(child.use(token)));
    expect(host.inspect().serviceLeases).toBe(1);
    expect(host.use(token)).toMatchObject({ ok: false, error: { code: "resource-limit" } });
    value(await host.closeScope(child));
    expect(host.inspect().serviceLeases).toBe(0);
    value(host.use(token));
    expect(host.inspect().serviceLeases).toBe(1);
  });
  it("global plugin limits apply across scopes and release after unload", async () => {
    const host = setup({ limits: { maxPlugins: 2 } });
    const child = value(host.createScope({ label: "child" }));

    const plugin = (name: string) => ({
      name,
      setup: () => ({ ok: true as const, value: undefined }),
    });

    const first = value(await host.install([plugin("first")]));
    value(await host.install([plugin("second")], { scope: child }));
    expect(await host.install([plugin("third")])).toMatchObject({
      ok: false,
      error: { code: "resource-limit" },
    });
    value(await host.uninstall(first.plugins[0]!));
    value(await host.install([plugin("third")]));
    expect(host.inspect().plugins).toHaveLength(2);
  });
  it("close reports include tasks that actually drain after cancellation", async () => {
    const host = setup();
    const gate = deferred<Result<void>>();
    const task = value(host.startTask({ label: "draining", run: () => gate.promise }));
    await flush();
    const closing = host.close();
    await flush();
    expect(host.inspect().activeTasks).toBe(1);
    expect(await host.wait(task)).toMatchObject({ ok: false, error: { code: "cancelled" } });
    gate.resolve({ ok: true, value: undefined });
    expect(value(await closing).settledTasks).toBe(1);
    expect(host.inspect().activeTasks).toBe(0);
  });
  it.each(["timeout", "cancelled"] as const)(
    "automatic join preserves a child's first %s despite late success",
    async (mode) => {
      const time = clock();
      const host = setup({ scheduler: time.scheduler });
      const gate = deferred<Result<void>>();
      let child!: TaskHandle<void>;
      const parent = value(
        host.startTask({
          label: "parent",
          timeoutMs: 100,
          run(call) {
            child = value(call.spawn({ label: "child", timeoutMs: 10, run: () => gate.promise }));
            return { ok: true, value: undefined };
          },
        }),
      );
      await flush();

      if (mode === "timeout") time.advance(10);
      else value(child.cancel());

      expect(host.inspect().activeTasks).toBe(2);
      gate.resolve({ ok: true, value: undefined });
      expect(await host.wait(parent)).toMatchObject({ ok: false, error: { code: mode } });
      expect(await host.wait(child)).toMatchObject({ ok: false, error: { code: mode } });
      await flush();
      expect(host.inspect().activeTasks).toBe(0);
    },
  );
  it("pre-registered cleanup releases a resource created after outward cancellation", async () => {
    const host = setup();
    const gate = deferred<Result<void>>();
    let opened = false;
    let released = false;
    const task = value(
      host.startTask({
        label: "create",
        async run(call) {
          const registration = call.effect(() => {
            expect(opened).toBe(true);
            released = true;
            return { ok: true, value: undefined };
          });

          if (!registration.ok) return registration;

          await gate.promise;
          opened = true;
          return { ok: true, value: undefined };
        },
      }),
    );
    await flush();
    const closing = host.close();
    await flush();
    expect(await host.wait(task)).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(released).toBe(false);
    gate.resolve({ ok: true, value: undefined });
    value(await closing);
    expect(released).toBe(true);
    expect(host.inspect().effects).toBe(0);
  });
});
