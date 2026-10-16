import { afterEach, describe, expect, it } from "vitest";
import { createHost, defineService } from "../../index";
import type { Context, HostOptions, Result, Host, ServiceToken } from "../../index";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
}

type Endpoint = { run(input: void): Promise<Result<string>> };
const roots: Host[] = [];
function setup(options?: HostOptions) {
  const host = value(createHost(options));
  roots.push(host);
  return host;
}
function endpoint(name: string): ServiceToken<Endpoint> {
  return value(defineService<Endpoint>({ name, methods: { run: {} } }));
}
function clock() {
  let time = 0;
  let identity = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    scheduler: {
      now: () => time,
      delay(callback: () => void, ms: number) {
        const id = ++identity;
        timers.set(id, { at: time + ms, callback });
        return () => { timers.delete(id); };
      },
    },
    advance(ms: number) {
      time += ms;
      for (const [id, timer] of timers) {
        if (timer.at > time) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

afterEach(async () => {
  for (const host of roots.splice(0)) await host.close();
});

describe("architecture transaction invariants", () => {
  it("staging reservation rejects host provide instead of publishing two active generations", async () => {
    const host = setup();
    const token = endpoint("reservation");
    const gate = deferred<void>();
    const installing = host.install([{ name: "plugin", provides: { token }, async setup(ctx) {
      const provided = ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "plugin" }) });
      if (!provided.ok) return provided;
      await gate.promise;
      return { ok: true, value: undefined };
    } }]);
    await flush();
    const competing = host.register(token, { run: () => Promise.resolve({ ok: true, value: "host" }) });
    gate.resolve();
    value(await installing);
    const child = value(host.createScope({ label: "consumer" }));
    const outputs = [
      value(await value(host.use(token)).run(undefined)),
      value(await value(child.use(token)).run(undefined)),
    ];
    expect({ competing, outputs }).toMatchObject({
      competing: { ok: false, error: { code: "duplicate-provider" } },
      outputs: ["plugin", "plugin"],
    });
  });

  it("rollback cancels the entire cohort before any cancel-cooperative disposer waits", async () => {
    const time = clock();
    const host = setup({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } });
    let first!: Context;
    const installing = host.install([
      { name: "first", setup(ctx) { first = ctx; return { ok: true, value: undefined }; } },
      { name: "second", setup(ctx) {
        value(ctx.addCleanup(() => {
          if (first.signal.aborted) return { ok: true, value: undefined };
          return new Promise<Result<void>>((resolve) => {
            first.signal.addEventListener("abort", () => resolve({ ok: true, value: undefined }), { once: true });
          });
        }));
        return { ok: false, error: "activation rejected" };
      } },
    ]);
    await flush();
    time.advance(10);
    const result = await installing;
    const inspection = host.inspect();
    const firstCancelled = first.signal.aborted;
    const disposing = host.close();
    await flush();
    await disposing;
    expect({ result, inspection, firstCancelled }).toMatchObject({
      result: { ok: false, error: { code: "activation-failed" } },
      inspection: { degraded: false, plugins: [], effects: 0 },
      firstCancelled: true,
    });
  });

  it("owner background task does not inherit activation parent or block commit", async () => {
    const time = clock();
    const host = setup({ scheduler: time.scheduler, limits: { activationTimeoutMs: 10, callTimeoutMs: 1000 } });
    let parentId: string | undefined;
    let cancelled = false;
    const installing = host.install([{ name: "worker", setup(ctx) {
      value(ctx.startTask({ label: "background", run(call) {
        parentId = call.parentId;
        return new Promise<Result<void>>((resolve) => {
          call.signal.addEventListener("abort", () => {
            cancelled = true;
            resolve({ ok: true, value: undefined });
          }, { once: true });
        });
      } }));
      return { ok: true, value: undefined };
    } }]);
    await flush();
    time.advance(10);
    const result = await installing;
    const inspection = host.inspect();
    await host.close();
    expect({ result, parentId, inspection, cancelled }).toMatchObject({
      result: { ok: true },
      parentId: undefined,
      inspection: { plugins: [{ state: "active" }], activeTasks: 1 },
      cancelled: true,
    });
  });

  it("missing optional definitions still reserve root definition budget", async () => {
    const host = setup({ limits: { maxDefinitions: 1 } });
    const a = endpoint("optional-a");
    const b = endpoint("optional-b");
    expect(await host.install([{ name: "consumer", optional: { a, b }, setup() {
      return { ok: true, value: undefined };
    } }])).toMatchObject({ ok: false, error: { code: "resource-limit" } });
  });

  it("missing optional definition identity cannot be replaced by another token with its name", async () => {
    const host = setup();
    const original = endpoint("identity");
    value(await host.install([{ name: "consumer", optional: { original }, setup() {
      return { ok: true, value: undefined };
    } }]));
    const replacement = endpoint("identity");
    expect(host.register(replacement, { run: () => Promise.resolve({ ok: true, value: "replacement" }) }))
      .toMatchObject({ ok: false, error: { code: "definition-conflict" } });
  });

  it("subtree close receipt includes every plugin that the successful close stopped", async () => {
    const host = setup();
    const child = value(host.createScope({ label: "application" }));
    const grandchild = value(child.createScope({ label: "agent" }));
    value(await host.install([{ name: "application", setup() { return { ok: true, value: undefined }; } }], { scope: child }));
    value(await host.install([{ name: "agent", setup() { return { ok: true, value: undefined }; } }], { scope: grandchild }));
    const receipt = value(await host.closeScope(child));
    expect(host.inspect()).toMatchObject({ plugins: [], scopes: 1 });
    expect(receipt.stoppedPlugins.map((plugin) => plugin.name).sort()).toEqual(["agent", "application"]);
  });

  it("subtree close receipt cannot report negative released effects from unrelated registration", async () => {
    const host = setup();
    const child = value(host.createScope({ label: "application" }));
    const gate = deferred<void>();
    let cleaning = false;
    value(child.addCleanup(async () => {
      cleaning = true;
      await gate.promise;
      return { ok: true, value: undefined };
    }));
    const closing = host.closeScope(child);
    await flush();
    expect(cleaning).toBe(true);
    value(host.addCleanup(() => ({ ok: true, value: undefined })));
    value(host.addCleanup(() => ({ ok: true, value: undefined })));
    gate.resolve();
    const receipt = value(await closing);
    expect(host.inspect()).toMatchObject({ effects: 2, scopes: 1 });
    expect(receipt.releasedEffects).toBe(1);
  });

  it("ordinary staging stays invisible and rollback leaves no published capability", async () => {
    const host = setup();
    const token = endpoint("atomic");
    const gate = deferred<void>();
    const installing = host.install([{ name: "provider", provides: { token }, async setup(ctx) {
      value(ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "hidden" }) }));
      await gate.promise;
      return { ok: false, error: "failed" };
    } }]);
    await flush();
    expect(host.use(token)).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    gate.resolve();
    expect(await installing).toMatchObject({ ok: false, error: { code: "activation-failed" } });
    expect(host.inspect()).toMatchObject({ plugins: [], effects: 0, degraded: false });
  });

  it("old facade never redirects to a replacement provider generation", async () => {
    const host = setup();
    const token = endpoint("generations");
    const provider = (name: string) => ({ name, provides: { token }, setup(ctx: Context) {
      return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: name }) });
    } });
    const first = value(await host.install([provider("first")]));
    const retained = value(host.use(token));
    value(await host.uninstall(first.plugins[0]!));
    value(await host.install([provider("second")]));
    expect(await retained.run(undefined)).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    expect(value(await value(host.use(token)).run(undefined))).toBe("second");
  });

  it("separate roots isolate state budgets definitions and foreign lifecycle identities", async () => {
    const a = setup({ limits: { maxDefinitions: 1, maxPlugins: 1 } });
    const b = setup({ limits: { maxDefinitions: 1, maxPlugins: 1 } });
    const token = endpoint("instances");
    const provider = { name: "provider", provides: { token }, setup(ctx: Context) {
      let count = 0;
      return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: String(++count) }) });
    } };
    const loadedA = value(await a.install([provider]));
    const loadedB = value(await b.install([provider]));
    expect(value(await value(a.use(token)).run(undefined))).toBe("1");
    expect(value(await value(a.use(token)).run(undefined))).toBe("2");
    expect(value(await value(b.use(token)).run(undefined))).toBe("1");
    expect(await a.uninstall(loadedB.plugins[0]!)).toMatchObject({ ok: false, error: { code: "plugin-not-found" } });
    expect(await a.install([{ name: "extra", setup() { return { ok: true, value: undefined }; } }]))
      .toMatchObject({ ok: false, error: { code: "resource-limit" } });
    value(await a.uninstall(loadedA.plugins[0]!));
    expect(b.inspect()).toMatchObject({ plugins: [{ state: "active" }], degraded: false });
  });
});
