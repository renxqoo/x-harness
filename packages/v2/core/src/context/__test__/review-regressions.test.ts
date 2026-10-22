import { afterEach, describe, expect, it } from "vitest";
import { defineChain, defineGuard, defineService } from "../../index";
import type { Context, Disposer, Invocation, Result, Host } from "../../index";
import { clock, deferred, flush, number, root, text, value } from "../../__test__/helpers";

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
    defineService<{ run(input: string): Promise<Result<string>> }>({ name, methods: { run: {} } }),
  );

describe("adversarial lifecycle regressions", () => {
  it("host-owned consumer cleanup retains provider implementations and their long-lived resources", async () => {
    const host = setup();
    const token = service("subscription");
    let providerAlive = false;
    let released = false;
    const endpoint = value(
      defineService<{ open(input: void): Promise<Result<Disposer>> }>({
        name: "open",
        methods: { open: {} },
      }),
    );
    value(
      await host.install([
        {
          name: "provider",
          provides: { token, endpoint },
          setup(ctx) {
            providerAlive = true;
            value(
              ctx.addCleanup(() => {
                providerAlive = false;
                return { ok: true, value: undefined };
              }),
            );
            value(
              ctx.register(token, {
                run(input) {
                  expect(providerAlive).toBe(true);
                  released = true;
                  return Promise.resolve({ ok: true, value: input });
                },
              }),
            );
            return ctx.register(endpoint, {
              open(_input, call) {
                return Promise.resolve(
                  call.effect(async (cleanup) => {
                    const dependency = cleanup.context.use(token);

                    if (!dependency.ok) return dependency;

                    const result = await dependency.value.run("release");

                    if (!result.ok) return result;

                    return { ok: true, value: undefined };
                  }),
                );
              },
            });
          },
        },
      ]),
    );
    value(await value(host.use(endpoint)).open(undefined));
    value(await host.close());
    expect(released).toBe(true);
    expect(providerAlive).toBe(false);
    expect(host.inspect().effects).toBe(0);
  });
  it("cleanup bind preserves its independent cancellation and deadline across nested providers", async () => {
    const host = setup();
    const a = service("a");
    const b = service("b");
    const c = service("c");
    let calls = 0;
    let phase: Invocation["phase"] | undefined;
    value(
      await host.install([
        {
          name: "c",
          provides: { c },
          setup(ctx) {
            return ctx.register(c, {
              run(input, call) {
                calls += 1;
                phase = call.phase;
                return Promise.resolve({ ok: true, value: input });
              },
            });
          },
        },
        {
          name: "b",
          provides: { b },
          requires: { c },
          setup(ctx) {
            return ctx.register(b, {
              async run(input, call) {
                const bound = call.bind(ctx);

                if (!bound.ok) return bound;

                const child = bound.value.use(c);

                if (!child.ok) return child;

                return child.value.run(input);
              },
            });
          },
        },
        {
          name: "a",
          provides: { a },
          requires: { b },
          setup(ctx) {
            value(
              ctx.addCleanup(async (cleanup) => {
                const dependency = cleanup.context.use(b);

                if (!dependency.ok) return dependency;

                const result = await dependency.value.run("cleanup");

                if (!result.ok) return result;

                return { ok: true, value: undefined };
              }),
            );
            return ctx.register(a, { run: (input) => Promise.resolve({ ok: true, value: input }) });
          },
        },
      ]),
    );
    value(await host.close());
    expect(calls).toBe(1);
    expect(phase).toBe("cleanup");
  });
  it("foreign PluginRef with identical local instance strings cannot unload this host", async () => {
    const a = setup();
    const b = setup();
    const plugin = {
      name: "same",
      setup() {
        return { ok: true as const, value: undefined };
      },
    };
    const installedA = value(await a.install([plugin]));
    const installedB = value(await b.install([plugin]));
    expect(installedA.plugins[0]).toEqual(installedB.plugins[0]);
    expect((await a.uninstall(installedB.plugins[0]!)).ok).toBe(false);
    expect(a.inspect().plugins).toHaveLength(1);
    value(await a.uninstall(a.inspect().plugins[0]!.ref));
    expect(a.inspect().plugins).toHaveLength(0);
  });
  it("invalid wait options cannot mark an unhandled child failure as observed", async () => {
    const host = setup();
    const parent = value(
      host.startTask({
        label: "parent",
        async run(call) {
          const child = value(
            call.spawn({
              label: "child",
              run() {
                throw new Error("child failed");
              },
            }),
          );
          expect(await call.wait(child, { timeoutMs: 0 })).toMatchObject({
            ok: false,
            error: { code: "invalid-input" },
          });
          return { ok: true, value: undefined };
        },
      }),
    );
    expect(await host.wait(parent)).toMatchObject({
      ok: false,
      error: { code: "callback-failed" },
    });
  });
  it("owning a child scope cannot adopt another plugin context and its dependencies", async () => {
    const host = setup();
    const restricted = service("restricted");
    const entry = service("entry");
    let child!: Context;
    let other!: Context;
    value(
      host.register(restricted, { run: (input) => Promise.resolve({ ok: true, value: input }) }),
    );
    value(
      await host.install([
        {
          name: "creator",
          provides: { entry },
          setup(ctx) {
            child = value(ctx.createScope({ label: "child" }));
            return ctx.register(entry, {
              run(_input, call) {
                expect(ctx.use(restricted).ok).toBe(false);
                expect(call.bind(other).ok).toBe(false);
                return Promise.resolve({ ok: true, value: "isolated" });
              },
            });
          },
        },
      ]),
    );
    value(
      await host.install(
        [
          {
            name: "other",
            requires: { restricted },
            setup(ctx) {
              other = ctx;
              return { ok: true, value: undefined };
            },
          },
        ],
        { scope: child },
      ),
    );
    expect(value(await value(host.use(entry)).run("a"))).toBe("isolated");
  });
  it("requestClose inside a child plugin stops only its own owner", async () => {
    const host = setup();
    const child = value(host.createScope({ label: "child" }));
    let first!: Context;
    let second!: Context;
    value(
      await host.install(
        [
          {
            name: "first",
            setup(ctx) {
              first = ctx;
              return { ok: true, value: undefined };
            },
          },
          {
            name: "second",
            setup(ctx) {
              second = ctx;
              return { ok: true, value: undefined };
            },
          },
        ],
        { scope: child },
      ),
    );
    value(first.requestClose());
    await flush();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(child.scopeState).toBe("open");
  });
  it("cleanup dispatch keeps guard handlers and chain middleware available", async () => {
    const host = setup();
    const gate = value(defineGuard({ name: "gate", input: text }));
    const chain = value(defineChain({ name: "pipeline", input: text, output: number }));
    const visits: string[] = [];
    value(
      await host.install([
        {
          name: "gate-provider",
          provides: { gate, chain },
          setup(ctx) {
            value(ctx.register(chain, () => ({ ok: true, value: 1 })));
            value(
              ctx.guard(gate, (_input, call) => {
                expect(call.phase).toBe("cleanup");
                visits.push("guard");
                return { ok: true, value: { kind: "allow" } };
              }),
            );
            return ctx.middleware(chain, (input, next) => {
              visits.push("middleware");
              return next(input);
            });
          },
        },
        {
          name: "consumer",
          requires: { gate, chain },
          setup(ctx) {
            return ctx.addCleanup(async (cleanup) => {
              const policy = await cleanup.context.dispatch(gate, "cleanup");

              if (!policy.ok) return policy;

              const execution = await cleanup.context.dispatch(chain, "cleanup");

              if (!execution.ok) return execution;

              return { ok: true, value: undefined };
            });
          },
        },
      ]),
    );
    value(await host.close());
    expect(visits).toEqual(["guard", "middleware"]);
  });
  it("unfinished next requests cancellation before actual child convergence", async () => {
    const host = setup();
    const gate = deferred<Result<number>>();
    const chain = value(defineChain({ name: "unfinished", input: text, output: number }));
    let signal!: AbortSignal;
    value(
      host.register(chain, (_input, call) => {
        signal = call.signal;
        return gate.promise;
      }),
    );
    value(
      host.middleware(chain, (input, next) => {
        next(input);
        return { ok: true, value: 2 };
      }),
    );
    const result = host.dispatch(chain, "a");
    await flush();
    expect(await result).toMatchObject({ ok: false, error: { code: "unfinished-next" } });
    expect(signal.aborted).toBe(true);
    gate.resolve({ ok: true, value: 1 });
    await flush();
  });
  it("a wait timeout cannot swallow a later child failure", async () => {
    const time = clock();
    const host = setup({ scheduler: time.scheduler });
    const gate = deferred<Result<void>>();
    const task = value(
      host.startTask({
        label: "parent",
        async run(call) {
          const child = value(call.spawn({ label: "child", run: () => gate.promise }));
          await call.wait(child, { timeoutMs: 10 });
          return { ok: true, value: undefined };
        },
      }),
    );
    await flush();
    time.advance(10);
    await flush();
    gate.resolve({
      ok: false,
      error: { source: "core", code: "callback-failed", message: "child" },
    });
    expect(await host.wait(task)).toMatchObject({ ok: false, error: { code: "callback-failed" } });
  });
});
