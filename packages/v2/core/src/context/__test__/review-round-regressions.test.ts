import { afterEach, describe, expect, it } from "vitest";
import { createHost, defineEvent, defineService } from "../../index";
import type { Result, Host, Scheduler } from "../../index";

const roots: Host[] = [];
afterEach(async () => { for (const host of roots.splice(0)) await host.close(); });

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function setup(options?: Parameters<typeof createHost>[0]) {
  const host = value(createHost(options));
  roots.push(host);
  return host;
}

function clock() {
  let time = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  const scheduler: Scheduler = {
    now: () => time,
    delay(run, delayMs) {
      const timer = { at: time + delayMs, run };
      timers.add(timer);
      return () => { timers.delete(timer); };
    },
  };
  return { scheduler, timers, advance(ms: number) {
    time += ms;
    for (const timer of timers) if (timer.at <= time) { timers.delete(timer); timer.run(); }
  } };
}

describe("review round regressions", () => {
  it("an effect released by one owner can be registered again by another owner", async () => {
    const host = setup();
    const child = value(host.createScope({ label: "child" }));
    const shared = () => ({ ok: true, value: undefined } as const);
    const first = value(host.addCleanup(shared));
    value(await first());
    const second = child.addCleanup(shared);
    expect(second).toMatchObject({ ok: true });
  });

  it("a plugin module disposer survives load unload and reload cycles", async () => {
    const host = setup();
    const shared = () => ({ ok: true, value: undefined } as const);
    const load = () => host.install([{ name: "cycle", setup(ctx) { return ctx.addCleanup(shared); } }]);
    const first = value(await load());
    value(await host.uninstall(first.plugins[0]!));
    const second = value(await load());
    expect(host.inspect()).toMatchObject({ plugins: [{ state: "active" }], effects: 1 });
    value(await host.uninstall(second.plugins[0]!));
    expect(host.inspect()).toMatchObject({ plugins: [], effects: 0 });
  });

  it("a failed manual release is not re-executed by a later host disposal", async () => {
    const host = setup({ limits: { closeTimeoutMs: 10 } });
    let runs = 0;
    const off = value(host.addCleanup((): Result<void> => {
      runs += 1;
      return { ok: false, error: { source: "core", code: "callback-failed", message: "transient" } as const };
    }));
    expect(await off()).toMatchObject({ ok: false, error: { code: "cleanup-failed" } });
    expect(runs).toBe(1);
    const disposed = await host.close();
    expect(disposed.ok).toBe(false);
    expect(runs).toBe(1);
  });

  it("a transient call-budget squeeze does not permanently revoke an accepted listener", async () => {
    const host = setup({ limits: { maxActiveCalls: 1 } });
    const token = value(defineEvent<string>({ name: "observer/revival", payload: (x) => ({ ok: true, value: x as string }) }));
    value(host.register(token));
    const deliveries: string[] = [];
    value(host.on(token, (input) => { deliveries.push(input); }));
    const holder = value(defineService<{ run(input: void): Promise<Result<number>> }>({ name: "observer/budget-holder", methods: { run: {} } }));
    let gate!: (result: Result<number>) => void;
    value(host.register(holder, { run: () => new Promise((resolve) => { gate = resolve; }) }));
    const holding = value(host.use(holder)).run(undefined);
    await new Promise((done) => setTimeout(done, 5));
    const first = value(host.emit(token, "one"));
    expect(first.acceptedListeners).toBe(1);
    gate({ ok: true, value: 0 });
    await holding;
    for (let turn = 0; turn < 40 && deliveries.length === 0; turn += 1) await new Promise((done) => setTimeout(done, 5));
    expect(deliveries).toEqual(["one"]);
    const second = value(host.emit(token, "two"));
    expect(second.acceptedListeners).toBe(1);
    for (let turn = 0; turn < 40 && deliveries.length < 2; turn += 1) await new Promise((done) => setTimeout(done, 5));
    expect(deliveries).toEqual(["one", "two"]);
  });

  it("a scheduler clock failure cannot escape the result boundary or wedge the ledger", async () => {
    let broken = false;
    const scheduler: Scheduler = {
      now: () => { if (broken) throw new Error("clock broke"); return Date.now(); },
      delay(callback, delayMs) { const timer = setTimeout(callback, delayMs); return () => clearTimeout(timer); },
    };
    const host = setup({ scheduler });
    const token = value(defineService<{ run(input: void): Promise<Result<number>> }>({ name: "clock/escape", methods: { run: {} } }));
    value(host.register(token, { async run() {
      await new Promise((done) => setTimeout(done, 20));
      return { ok: true, value: 1 };
    } }));
    const facade = value(host.use(token));
    const pending = facade.run(undefined).then((result) => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error }));
    await new Promise((done) => setTimeout(done, 5));
    broken = true;
    const settled = await pending;
    broken = false;
    await new Promise((done) => setTimeout(done, 40));
    expect(settled.ok).toBe(true);
    expect(host.inspect().activeCalls).toBe(0);
  });

  it("a re-entering diagnostic sink cannot recurse without bound", async () => {
    let sinkCalls = 0;
    const host = setup({ onDiagnostic() {
      sinkCalls += 1;
      const probe = host.use(value(defineService<{ run(input: void): Promise<Result<number>> }>({ name: `sink/probe-${sinkCalls}`, methods: { run: {} } })));
      expect(probe.ok).toBe(false);
    } });
    const token = value(defineService<{ run(input: void): Promise<Result<number>> }>({ name: "sink/absent", methods: { run: {} } }));
    const missing = host.use(token);
    expect(missing.ok).toBe(false);
    expect(sinkCalls).toBe(1);
  });

  it("an ancestor provider cannot publish over a provider already live in a descendant scope", async () => {
    const host = setup();
    const child = value(host.createScope({ label: "lineage" }));
    const token = value(defineService<{ run(input: void): Promise<Result<string>> }>({ name: "lineage/split", methods: { run: {} } }));
    value(child.register(token, { run: () => Promise.resolve({ ok: true, value: "child" }) }));
    const ancestor = host.register(token, { run: () => Promise.resolve({ ok: true, value: "root" }) });
    expect(ancestor).toMatchObject({ ok: false, error: { code: "duplicate-provider" } });
    const viaChild = await value(child.use(token)).run(undefined);
    expect(viaChild).toMatchObject({ ok: true, value: "child" });
    const viaRoot = host.use(token);
    expect(viaRoot).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
  });

  it("a staging batch cannot publish over a provider already live in a descendant scope", async () => {
    const host = setup();
    const child = value(host.createScope({ label: "descendant" }));
    const token = value(defineService<{ run(input: void): Promise<Result<string>> }>({ name: "lineage/staging", methods: { run: {} } }));
    value(child.register(token, { run: () => Promise.resolve({ ok: true, value: "child" }) }));
    const installed = await host.install([{ name: "ancestor-late", provides: { token }, setup(ctx) {
      return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "root" }) });
    } }]);
    expect(installed).toMatchObject({ ok: false, error: { code: "duplicate-provider" } });
    expect(host.inspect()).toMatchObject({ plugins: [] });
    const viaChild = await value(child.use(token)).run(undefined);
    expect(viaChild).toMatchObject({ ok: true, value: "child" });
  });

  it("closing the scheduler window never reports success after an outward close-incomplete", async () => {
    const time = clock();
    const host = setup({ scheduler: time.scheduler, limits: { closeTimeoutMs: 50 } });
    const gate = new Promise<Result<void>>((resolve) => {
      value(host.addCleanup(() => gate));
      setTimeout(() => resolve({ ok: true, value: undefined }), 10);
    });
    const closing = host.close();
    const settled = await closing;
    expect(settled).toMatchObject({ ok: true });
    expect(time.timers.size).toBe(0);
  });
});
