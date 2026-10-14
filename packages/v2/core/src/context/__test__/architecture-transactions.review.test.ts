import { afterEach, describe, expect, it } from "vitest";
import { createContext, defineService } from "../../index";
import type { Context, ContextOptions, Result, RootContext, ServiceToken } from "../../index";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.reason));
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
const roots: RootContext[] = [];
function setup(options?: ContextOptions) {
  const host = value(createContext(options));
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
  for (const host of roots.splice(0)) await host.dispose();
});

describe("architecture transaction invariants", () => {
  it("staging reservation rejects host provide instead of publishing two active generations", async () => {
    const host = setup();
    const token = endpoint("reservation");
    const gate = deferred<void>();
    const installing = host.load([{ name: "plugin", provides: [token], async apply(ctx) {
      const provided = ctx.provide(token, { run: () => Promise.resolve({ ok: true, value: "plugin" }) });
      if (!provided.ok) return provided;
      await gate.promise;
      return { ok: true, value: undefined };
    } }]);
    await flush();
    const competing = host.provide(token, { run: () => Promise.resolve({ ok: true, value: "host" }) });
    gate.resolve();
    value(await installing);
    const child = value(host.scope({ label: "consumer" }));
    const outputs = [
      value(await value(host.use(token)).run(undefined)),
      value(await value(child.use(token)).run(undefined)),
    ];
    expect({ competing, outputs }).toMatchObject({
      competing: { ok: false, reason: { code: "duplicate-provider" } },
      outputs: ["plugin", "plugin"],
    });
  });

  it("rollback cancels the entire cohort before any cancel-cooperative disposer waits", async () => {
    const time = clock();
    const host = setup({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } });
    let first!: Context;
    const installing = host.load([
      { name: "first", apply(ctx) { first = ctx; return { ok: true, value: undefined }; } },
      { name: "second", apply(ctx) {
        value(ctx.effect(() => {
          if (first.signal.aborted) return { ok: true, value: undefined };
          return new Promise<Result<void>>((resolve) => {
            first.signal.addEventListener("abort", () => resolve({ ok: true, value: undefined }), { once: true });
          });
        }));
        return { ok: false, reason: "activation rejected" };
      } },
    ]);
    await flush();
    time.advance(10);
    const result = await installing;
    const inspection = host.inspect();
    const firstCancelled = first.signal.aborted;
    const disposing = host.dispose();
    await flush();
    await disposing;
    expect({ result, inspection, firstCancelled }).toMatchObject({
      result: { ok: false, reason: { code: "activation-failed" } },
      inspection: { degraded: false, plugins: [], effects: 0 },
      firstCancelled: true,
    });
  });

  it("owner background task does not inherit activation parent or block commit", async () => {
    const time = clock();
    const host = setup({ scheduler: time.scheduler, limits: { activationTimeoutMs: 10, callTimeoutMs: 1000 } });
    let parentId: string | undefined;
    let cancelled = false;
    const installing = host.load([{ name: "worker", apply(ctx) {
      value(ctx.spawn({ label: "background", run(call) {
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
    await host.dispose();
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
    expect(await host.load([{ name: "consumer", optional: [a, b], apply() {
      return { ok: true, value: undefined };
    } }])).toMatchObject({ ok: false, reason: { code: "resource-limit" } });
  });

  it("missing optional definition identity cannot be replaced by another token with its name", async () => {
    const host = setup();
    const original = endpoint("identity");
    value(await host.load([{ name: "consumer", optional: [original], apply() {
      return { ok: true, value: undefined };
    } }]));
    const replacement = endpoint("identity");
    expect(host.provide(replacement, { run: () => Promise.resolve({ ok: true, value: "replacement" }) }))
      .toMatchObject({ ok: false, reason: { code: "definition-conflict" } });
  });

  it("subtree close receipt includes every plugin that the successful close stopped", async () => {
    const host = setup();
    const child = value(host.scope({ label: "application" }));
    const grandchild = value(child.scope({ label: "agent" }));
    value(await host.load([{ name: "application", apply() { return { ok: true, value: undefined }; } }], { scope: child }));
    value(await host.load([{ name: "agent", apply() { return { ok: true, value: undefined }; } }], { scope: grandchild }));
    const receipt = value(await host.closeScope(child));
    expect(host.inspect()).toMatchObject({ plugins: [], scopes: 1 });
    expect(receipt.stoppedPlugins.map((plugin) => plugin.name).sort()).toEqual(["agent", "application"]);
  });

  it("subtree close receipt cannot report negative released effects from unrelated registration", async () => {
    const host = setup();
    const child = value(host.scope({ label: "application" }));
    const gate = deferred<void>();
    let cleaning = false;
    value(child.effect(async () => {
      cleaning = true;
      await gate.promise;
      return { ok: true, value: undefined };
    }));
    const closing = host.closeScope(child);
    await flush();
    expect(cleaning).toBe(true);
    value(host.effect(() => ({ ok: true, value: undefined })));
    value(host.effect(() => ({ ok: true, value: undefined })));
    gate.resolve();
    const receipt = value(await closing);
    expect(host.inspect()).toMatchObject({ effects: 2, scopes: 1 });
    expect(receipt.releasedEffects).toBe(1);
  });

  it("ordinary staging stays invisible and rollback leaves no published capability", async () => {
    const host = setup();
    const token = endpoint("atomic");
    const gate = deferred<void>();
    const installing = host.load([{ name: "provider", provides: [token], async apply(ctx) {
      value(ctx.provide(token, { run: () => Promise.resolve({ ok: true, value: "hidden" }) }));
      await gate.promise;
      return { ok: false, reason: "failed" };
    } }]);
    await flush();
    expect(host.use(token)).toMatchObject({ ok: false, reason: { code: "service-unavailable" } });
    gate.resolve();
    expect(await installing).toMatchObject({ ok: false, reason: { code: "activation-failed" } });
    expect(host.inspect()).toMatchObject({ plugins: [], effects: 0, degraded: false });
  });

  it("old facade never redirects to a replacement provider generation", async () => {
    const host = setup();
    const token = endpoint("generations");
    const provider = (name: string) => ({ name, provides: [token], apply(ctx: Context) {
      return ctx.provide(token, { run: () => Promise.resolve({ ok: true, value: name }) });
    } });
    const first = value(await host.load([provider("first")]));
    const retained = value(host.use(token));
    value(await host.unload(first.plugins[0]!));
    value(await host.load([provider("second")]));
    expect(await retained.run(undefined)).toMatchObject({ ok: false, reason: { code: "service-unavailable" } });
    expect(value(await value(host.use(token)).run(undefined))).toBe("second");
  });

  it("separate roots isolate state budgets definitions and foreign lifecycle identities", async () => {
    const a = setup({ limits: { maxDefinitions: 1, maxPlugins: 1 } });
    const b = setup({ limits: { maxDefinitions: 1, maxPlugins: 1 } });
    const token = endpoint("instances");
    const provider = { name: "provider", provides: [token], apply(ctx: Context) {
      let count = 0;
      return ctx.provide(token, { run: () => Promise.resolve({ ok: true, value: String(++count) }) });
    } };
    const loadedA = value(await a.load([provider]));
    const loadedB = value(await b.load([provider]));
    expect(value(await value(a.use(token)).run(undefined))).toBe("1");
    expect(value(await value(a.use(token)).run(undefined))).toBe("2");
    expect(value(await value(b.use(token)).run(undefined))).toBe("1");
    expect(await a.unload(loadedB.plugins[0]!)).toMatchObject({ ok: false, reason: { code: "plugin-not-found" } });
    expect(await a.load([{ name: "extra", apply() { return { ok: true, value: undefined }; } }]))
      .toMatchObject({ ok: false, reason: { code: "resource-limit" } });
    value(await a.unload(loadedA.plugins[0]!));
    expect(b.inspect()).toMatchObject({ plugins: [{ state: "active" }], degraded: false });
  });
});
