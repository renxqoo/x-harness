import { afterEach, describe, expect, it } from "vitest";
import { defineService } from "../../index";
import type { Context, Disposer, Result, Host, TaskHandle } from "../../index";
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
    defineService<{ run(input: string): Promise<Result<string>> }>({ name, methods: { run: {} } }),
  );

describe("installation transactions", () => {
  it("failed activation never publishes partial capabilities and cleans in reverse order", async () => {
    const host = setup();
    const token = service("partial");
    const released: number[] = [];
    const loaded = await host.install([
      {
        name: "first",
        provides: { token },
        setup(ctx) {
          value(
            ctx.addCleanup(() => {
              released.push(1);
              return { ok: true, value: undefined };
            }),
          );
          return ctx.register(token, {
            run: (input) => Promise.resolve({ ok: true, value: input }),
          });
        },
      },
      {
        name: "second",
        requires: { token },
        setup(ctx) {
          value(
            ctx.addCleanup(() => {
              released.push(2);
              return { ok: true, value: undefined };
            }),
          );
          expect(host.use(token).ok).toBe(false);
          throw new Error("secret");
        },
      },
    ]);
    expect(loaded).toMatchObject({
      ok: false,
      error: { code: "callback-failed", pluginName: "second" },
    });
    expect(host.use(token).ok).toBe(false);
    expect(released).toEqual([2, 1]);
    expect(host.inspect().effects).toBe(0);
    expect(JSON.stringify(host.diagnostics())).not.toContain("secret");
  });
  it("a missing declared provider causes rollback", async () => {
    const host = setup();
    const token = service("missing");
    expect(
      await host.install([
        {
          name: "incomplete",
          provides: { token },
          setup() {
            return { ok: true, value: undefined };
          },
        },
      ]),
    ).toMatchObject({ ok: false, error: { code: "activation-failed" } });
    expect(host.inspect().plugins).toHaveLength(0);
  });
  it("missing required and cyclic dependencies are rejected before activation", async () => {
    const host = setup();
    const a = service("a");
    const b = service("b");
    let calls = 0;
    expect(
      await host.install([
        {
          name: "missing",
          requires: { a },
          setup() {
            calls += 1;
            return { ok: true, value: undefined };
          },
        },
      ]),
    ).toMatchObject({ ok: false, error: { code: "missing-dependency" } });
    expect(
      await host.install([
        {
          name: "a",
          provides: { a },
          requires: { b },
          setup() {
            calls += 1;
            return { ok: true, value: undefined };
          },
        },
        {
          name: "b",
          provides: { b },
          requires: { a },
          setup() {
            calls += 1;
            return { ok: true, value: undefined };
          },
        },
      ]),
    ).toMatchObject({ ok: false, error: { code: "dependency-cycle" } });
    expect(calls).toBe(0);
  });
  it("root mutation capacity is reserved before queueing a later operation", async () => {
    const host = setup({ limits: { maxPendingMutations: 1 } });
    const gate = deferred<void>();
    const pending = host.install([
      {
        name: "slow",
        async setup() {
          await gate.promise;
          return { ok: true, value: undefined };
        },
      },
    ]);
    await flush();
    expect(await host.install([])).toMatchObject({ ok: false, error: { code: "resource-limit" } });
    gate.resolve();
    expect((await pending).ok).toBe(true);
    expect((await host.install([])).ok).toBe(true);
  });
  it("scope closure bypasses an ongoing activation and prevents publication", async () => {
    const host = setup();
    const gate = deferred<void>();
    let active!: Context;
    const pending = host.install([
      {
        name: "slow",
        async setup(ctx) {
          active = ctx;
          await gate.promise;
          return { ok: true, value: undefined };
        },
      },
    ]);
    await flush();
    const closing = host.close();
    expect(active.signal.aborted).toBe(true);
    expect(host.scopeState).toBe("closing");
    gate.resolve();
    expect((await pending).ok).toBe(false);
    expect((await closing).ok).toBe(true);
    expect(host.inspect().plugins).toHaveLength(0);
  });
  it("activation timeout retains and cleans a late acquired resource", async () => {
    const time = clock();
    const host = setup({ scheduler: time.scheduler, limits: { activationTimeoutMs: 10 } });
    const late = deferred<Result<number>>();
    let released = 0;
    const pending = host.install([
      {
        name: "late",
        setup(ctx) {
          return ctx.resource({
            open: () => late.promise,
            close: () => {
              released += 1;
              return { ok: true, value: undefined };
            },
          });
        },
      },
    ]);
    await flush();
    time.advance(10);
    await flush();
    expect(host.inspect().activeCalls).toBe(2);
    late.resolve({ ok: true, value: 1 });
    expect((await pending).ok).toBe(false);
    expect(released).toBe(1);
    value(await host.close());
    expect(time.timers.size).toBe(0);
  });
  it("the same plugin definition initializes separate state in different hosts", async () => {
    const a = setup();
    const b = setup();
    const token = service("instances");
    const plugin = {
      name: "state",
      provides: { token },
      setup(ctx: Context) {
        let calls = 0;
        return ctx.register(token, {
          run() {
            return Promise.resolve({ ok: true, value: String(++calls) });
          },
        });
      },
    };
    value(await a.install([plugin]));
    value(await b.install([plugin]));
    expect(value(await value(a.use(token)).run("a"))).toBe("1");
    expect(value(await value(a.use(token)).run("a"))).toBe("2");
    expect(value(await value(b.use(token)).run("a"))).toBe("1");
  });
  it("parent provider unload and child install are serialized in one root queue", async () => {
    const host = setup();
    const token = service("parent");
    const installed = value(
      await host.install([
        {
          name: "parent",
          provides: { token },
          setup(ctx) {
            return ctx.register(token, {
              run: (input) => Promise.resolve({ ok: true, value: input }),
            });
          },
        },
      ]),
    );
    const child = value(host.createScope({ label: "child" }));
    const removed = host.uninstall(installed.plugins[0]!);
    const added = host.install(
      [
        {
          name: "child",
          requires: { token },
          setup() {
            return { ok: true, value: undefined };
          },
        },
      ],
      { scope: child },
    );
    value(await removed);
    expect(await added).toMatchObject({ ok: false, error: { code: "missing-dependency" } });
  });
});

describe("honest resource and shutdown lifecycle", () => {
  it("concurrent disposal shares one promise and releases resources once", async () => {
    const host = setup();
    let calls = 0;

    const disposer: Disposer = () => {
      calls += 1;
      return { ok: true, value: undefined };
    };

    value(host.addCleanup(disposer));
    value(host.addCleanup(disposer));
    const first = host.close();
    expect(host.close()).toBe(first);
    value(await first);
    expect(calls).toBe(1);
    expect(host.inspect()).toMatchObject({ scopes: 0, effects: 0, activeCalls: 0, activeTasks: 0 });
  });
  it("cross-owner disposer registration fails without changing its original lifetime", async () => {
    const host = setup();
    const child = value(host.createScope({ label: "child" }));

    const disposer: Disposer = () => ({ ok: true, value: undefined });

    value(host.addCleanup(disposer));
    expect(child.addCleanup(disposer)).toMatchObject({
      ok: false,
      error: { code: "resource-conflict" },
    });
  });
  it("one failing disposer does not stop cleanup of the remaining resources", async () => {
    const host = setup();
    const released: string[] = [];
    value(
      host.addCleanup(() => {
        released.push("first");
        return { ok: true, value: undefined };
      }),
    );
    value(
      host.addCleanup(() => {
        released.push("failing");
        throw new Error("secret");
      }),
    );
    expect((await host.close()).ok).toBe(false);
    expect(released).toEqual(["failing", "first"]);
    expect(host.scopeState).toBe("close-failed");
    expect(host.inspect().effects).toBe(1);
    expect(JSON.stringify(host.diagnostics())).not.toContain("secret");
  });
  it("close deadline does not falsely settle real pending work and late convergence is visible", async () => {
    const time = clock();
    const host = setup({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } });
    const gate = deferred<Result<void>>();
    value(host.startTask({ label: "blocked", run: () => gate.promise }));
    await flush();
    const closing = host.close();
    await flush();
    time.advance(10);
    expect(await closing).toMatchObject({ ok: false, error: { code: "close-incomplete" } });
    expect(host.inspect()).toMatchObject({ state: "close-failed", activeTasks: 1 });
    gate.resolve({ ok: true, value: undefined });
    await flush();
    expect(host.inspect()).toMatchObject({ state: "closed", activeTasks: 0, effects: 0 });
    expect(await closing).toMatchObject({ ok: false, error: { code: "close-incomplete" } });
    expect(time.timers.size).toBe(0);
  });
  it("scope budgets cannot be loosened or bypass the root total", () => {
    const host = setup({ limits: { maxScopes: 2 } });
    expect(host.createScope({ label: "bad", limits: { maxScopes: 3 } }).ok).toBe(false);
    const child = value(host.createScope({ label: "child" }));
    expect(child.createScope({ label: "grandchild" })).toMatchObject({
      ok: false,
      error: { code: "resource-limit" },
    });
  });
  it("foreign contexts and plugin instances cannot control another host", async () => {
    const a = setup();
    const b = setup();
    const child = value(a.createScope({ label: "child" }));
    expect((await b.closeScope(child)).ok).toBe(false);
    expect((await b.install([], { scope: child })).ok).toBe(false);
    const installed = value(
      await a.install([
        {
          name: "plugin",
          setup() {
            return { ok: true, value: undefined };
          },
        },
      ]),
    );
    expect((await b.uninstall(installed.plugins[0]!)).ok).toBe(false);
  });
  it("diagnostics remain bounded and sink exceptions do not recurse", () => {
    const host = setup({
      limits: { maxDiagnostics: 2 },
      onDiagnostic() {
        throw new Error("secret");
      },
    });
    const token = service("missing");

    for (let call = 0; call < 10; call += 1) expect(host.use(token).ok).toBe(false);

    expect(host.diagnostics()).toHaveLength(2);
    expect(JSON.stringify(host.diagnostics())).not.toContain("secret");
  });
});

describe("structured tasks", () => {
  it("spawns, waits and closes a task without retained activities", async () => {
    const host = setup();
    const task = value(host.startTask({ label: "work", run: () => ({ ok: true, value: 8 }) }));
    expect(value(await host.wait(task))).toBe(8);
    expect(task.state).toBe("settled");
    expect(host.inspect().activeTasks).toBe(0);
  });
  it("a parent waits for actual child completion even when its body has returned", async () => {
    const host = setup();
    const gate = deferred<Result<void>>();
    const parent = value(
      host.startTask({
        label: "parent",
        run(call) {
          value(call.spawn({ label: "child", run: () => gate.promise }));
          return { ok: true, value: "parent" };
        },
      }),
    );
    await flush();
    expect(parent.state).toBe("running");
    gate.resolve({ ok: true, value: undefined });
    expect(value(await host.wait(parent))).toBe("parent");
  });
  it("implicit parent-child joins detect a child waiting on its parent", async () => {
    const host = setup();
    let parent!: TaskHandle<void>;
    parent = value(
      host.startTask<void>({
        label: "parent",
        run(call) {
          value(call.spawn({ label: "child", run: (inner) => inner.wait(parent) }));
          return { ok: true, value: undefined };
        },
      }),
    );
    expect(await host.wait(parent)).toMatchObject({ ok: false, error: { code: "wait-cycle" } });
  });
  it("wait timeout only ends the wait and does not cancel its target", async () => {
    const time = clock();
    const host = setup({ scheduler: time.scheduler });
    const gate = deferred<Result<number>>();
    let signal!: AbortSignal;
    const task = value(
      host.startTask({
        label: "target",
        run(call) {
          signal = call.signal;
          return gate.promise;
        },
      }),
    );
    const wait = host.wait(task, { timeoutMs: 10 });
    await flush();
    time.advance(10);
    expect(await wait).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(signal.aborted).toBe(false);
    gate.resolve({ ok: true, value: 1 });
    expect(value(await host.wait(task))).toBe(1);
  });
  it("explicit cancellation returns cancelled while the task remains actually running", async () => {
    const host = setup();
    const gate = deferred<Result<void>>();
    const task = value(host.startTask({ label: "task", run: () => gate.promise }));
    await flush();
    value(task.cancel());
    expect(await host.wait(task)).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(task.state).toBe("running");
    gate.resolve({ ok: true, value: undefined });
    await flush();
    expect(task.state).toBe("settled");
  });
  it("task identities are not accepted by a foreign root", async () => {
    const a = setup();
    const b = setup();
    const task = value(a.startTask({ label: "task", run: () => ({ ok: true, value: 1 }) }));
    expect((await b.wait(task)).ok).toBe(false);
  });
});
