import { afterEach, expect, it } from "vitest";
import { defineEvent, defineService } from "../../index";
import type { CoreFault, Host, Result } from "../../index";
import { clock, deferred, flush, root, text, value } from "../../__test__/helpers";

const hosts: Host[] = [];

const create = (options?: Parameters<typeof root>[0]) => {
  const host = root(options);
  hosts.push(host);
  return host;
};

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

const service = (name: string) =>
  value(
    defineService<{ run(input: string): Promise<Result<string>> }>({ name, methods: { run: {} } }),
  );

const ok = (): Result<void> => ({ ok: true, value: undefined });

const implementation = {
  run: (input: string): Promise<Result<string>> => Promise.resolve({ ok: true, value: input }),
};

function failure(result: Result<unknown>): CoreFault {
  expect(result.ok).toBe(false);

  if (result.ok) throw new Error("Expected failure");

  return result.error;
}

function recorded(host: Host, error: CoreFault) {
  const diagnostic = host.diagnostics().find((item) => item.id === error.diagnosticId);
  expect(diagnostic).toMatchObject({ code: error.code, scopeId: error.scopeId });
  expect(diagnostic?.details).toBe(error.details);
  return diagnostic;
}

it("inspection preserves task labels and parent waits after cancellation until actual completion", async () => {
  const host = create();
  const gate = deferred<Result<void>>();
  const parent = value(
    host.startTask({
      label: "parent",
      run(call) {
        value(call.spawn({ label: "child", run: () => gate.promise }));
        return ok();
      },
    }),
  );
  await flush();
  const before = host.inspect();
  expect(before.work).toHaveLength(2);
  const child = before.work.find((work) => work.label === "child")!;
  expect(before.work.find((work) => work.id === parent.id)).toMatchObject({
    bodyComplete: true,
    waitingFor: [child.id],
  });
  expect(child).toMatchObject({
    parentId: parent.id,
    kind: "task",
    phase: "business",
    executor: { kind: "host" },
    resourceOwner: { id: "host" },
  });
  value(parent.cancel());
  expect(host.inspect().work.every((work) => work.cancelled)).toBe(true);
  expect(before.work.every((work) => !work.cancelled)).toBe(true);
  expect(Object.isFrozen(child.waitingFor)).toBe(true);
  gate.resolve(ok());
  await flush();
  expect(host.inspect().work).toEqual([]);
  expect(before.work).toHaveLength(2);
});

it("inspection exposes explicit waits and removes them after completion", async () => {
  const host = create();
  const gate = deferred<Result<void>>();
  const target = value(host.startTask({ label: "target", run: () => gate.promise }));
  const waiter = value(host.startTask({ label: "waiter", run: (call) => call.wait(target) }));
  await flush();
  expect(host.inspect().work.find((work) => work.id === waiter.id)?.waitingFor).toEqual([
    target.id,
  ]);
  gate.resolve(ok());
  value(await host.wait(waiter));
  expect(host.inspect().activeWaits).toBe(0);
  expect(host.inspect().work).toEqual([]);
});

it("resource snapshots distinguish registration paths and omit actual resource values", async () => {
  const host = create();
  const token = service("storage");
  const event = value(defineEvent({ name: "updated", payload: text }));
  value(host.register(token, implementation));
  value(host.register(event));
  value(host.on(event, () => {}));
  value(host.addCleanup(ok));
  value(
    await host.resource({
      open: () => ({ ok: true, value: { secret: "connection value" } }),
      close: ok,
    }),
  );
  const resources = host.inspect().resources;
  expect(new Set(resources.map((resource) => resource.kind))).toEqual(
    new Set(["provider", "registration", "cleanup", "resource"]),
  );
  expect(
    resources.every(
      (resource) =>
        resource.state === "active" &&
        resource.owner.id === "host" &&
        resource.executor.id === "host",
    ),
  ).toBe(true);
  expect(Object.isFrozen(resources[0]!.dependencies[0]!.definition)).toBe(true);
  expect(JSON.stringify(resources)).not.toContain("connection value");
  value(await host.close());
  expect(host.inspect().resources).toEqual([]);
  expect(resources).toHaveLength(5);
});

it("scope close details exclude siblings and stay frozen after late convergence", async () => {
  const time = clock();
  const host = create({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } });
  const a = value(host.createScope({ label: "a" }));
  const b = value(host.createScope({ label: "b" }));
  const gate = deferred<Result<void>>();
  const other = deferred<Result<void>>();
  const task = value(a.startTask({ label: "blocked-a", run: () => gate.promise }));
  value(b.startTask({ label: "blocked-b", run: () => other.promise }));
  await flush();
  const closing = host.closeScope(a);
  await flush();
  time.advance(10);
  const error = failure(await closing);
  expect(error).toMatchObject({
    code: "close-incomplete",
    scopeId: a.scopeId,
    details: {
      work: { total: 1, omitted: 0, items: [{ id: task.id, label: "blocked-a", cancelled: true }] },
      resources: { total: 0, omitted: 0, items: [] },
    },
  });
  recorded(host, error);
  const saved = JSON.stringify(error);
  gate.resolve(ok());
  await flush();
  expect(a.scopeState).toBe("closed");
  expect(JSON.stringify(error)).toBe(saved);
  other.resolve(ok());
  await flush();
});

it("plugin uninstall deadline identifies tasks from the cascade selection", async () => {
  const time = clock();
  const host = create({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } });
  const token = service("storage");
  const gate = deferred<Result<void>>();
  const installed = value(
    await host.install([
      { name: "storage", provides: { token }, setup: (ctx) => ctx.register(token, implementation) },
      {
        name: "consumer",
        requires: { token },
        setup(ctx) {
          return ctx.startTask({ label: "refresh", run: () => gate.promise });
        },
      },
    ]),
  );
  await flush();
  const closing = host.uninstall(installed.plugins[0]!, { cascade: true });
  await flush();
  time.advance(10);
  const error = failure(await closing);
  expect(error).toMatchObject({
    code: "close-incomplete",
    pluginName: "storage",
    details: {
      work: { total: 1, items: [{ label: "refresh", executor: { pluginName: "consumer" } }] },
    },
  });
  recorded(host, error);
  gate.resolve(ok());
  await flush();
  expect(host.inspect().plugins).toEqual([]);
});

it("manual cleanup deadline identifies its closing resource and allows late release", async () => {
  const time = clock();
  const host = create({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } });
  const gate = deferred<Result<void>>();
  const dispose = value(host.addCleanup(() => gate.promise));
  const id = host.inspect().resources[0]!.id;
  const releasing = dispose();
  await flush();
  expect(host.inspect().resources[0]!.state).toBe("closing");
  time.advance(10);
  const error = failure(await releasing);
  expect(error).toMatchObject({
    code: "close-incomplete",
    details: {
      resourceId: id,
      resources: {
        total: 1,
        items: [{ id, kind: "cleanup", state: "closing", owner: { id: "host" } }],
      },
    },
  });
  recorded(host, error);
  gate.resolve(ok());
  await flush();
  expect(host.inspect().resources).toEqual([]);
});

it("pending service methods show the executor and the caller-owned resource separately", async () => {
  const host = create();
  const token = service("database");
  const gate = deferred<Result<string>>();
  value(
    await host.install([
      {
        name: "storage",
        provides: { token },
        setup(ctx) {
          return ctx.register(token, { run: () => gate.promise });
        },
      },
    ]),
  );
  const child = value(host.createScope({ label: "request" }));
  const pending = value(child.use(token)).run("private input");
  await flush();
  expect(host.inspect().work).toMatchObject([
    {
      label: "database.run",
      kind: "call",
      executor: { pluginName: "storage", scopeId: "root" },
      resourceOwner: { kind: "host", scopeId: child.scopeId },
    },
  ]);
  expect(JSON.stringify(host.inspect())).not.toContain("private input");
  gate.resolve({ ok: true, value: "private output" });
  value(await pending);
  expect(host.inspect().work).toEqual([]);
});

it("manual cleanup failures include only that resource's pending service calls", async () => {
  const time = clock();
  const host = create({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } });
  const storage = service("storage");
  const other = service("other");
  const first = deferred<Result<string>>();
  const second = deferred<Result<string>>();
  value(host.register(storage, { run: () => first.promise }));
  value(host.register(other, { run: () => second.promise }));
  const offStorage = value(
    host.addCleanup(async (cleanup) => {
      await value(cleanup.context.use(storage)).run("input");
      return ok();
    }),
  );
  const offOther = value(
    host.addCleanup(async (cleanup) => {
      await value(cleanup.context.use(other)).run("input");
      return ok();
    }),
  );
  const releasingStorage = offStorage();
  const releasingOther = offOther();
  await flush();
  expect(host.inspect().work).toHaveLength(2);
  time.advance(10);
  const error = failure(await releasingStorage);
  const otherError = failure(await releasingOther);
  expect(error.details).toMatchObject({
    work: { total: 1, items: [{ label: "storage.run", phase: "cleanup" }] },
  });
  expect(otherError.details).toMatchObject({
    work: { total: 1, items: [{ label: "other.run", phase: "cleanup" }] },
  });
  recorded(host, error);
  recorded(host, otherError);
  first.resolve({ ok: true, value: "done" });
  second.resolve({ ok: true, value: "done" });
  await flush();
  expect(host.inspect().work).toEqual([]);
  value(await host.close());
});

it("throwing timer cancellation cannot leave scope close pending or unhandled", async () => {
  const time = clock();
  const host = create({
    scheduler: {
      now: () => time.scheduler.now(),
      delay(callback, duration) {
        const cancel = time.scheduler.delay(callback, duration);

        return () => {
          cancel();
          throw new Error("private cancellation");
        };
      },
    },
  });
  value(await host.close());
  expect(host.inspect().state).toBe("closed");
  expect(time.timers.size).toBe(0);
});

it("long service method names cannot discard the entire close diagnostic", async () => {
  const time = clock();
  const host = create({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } });
  const method = "r".repeat(70000);
  const gate = deferred<Result<void>>();
  const token = value(
    defineService<Record<string, (input: void) => Promise<Result<void>>>>({
      name: "storage",
      methods: { [method]: {} },
    }),
  );
  value(host.register(token, { [method]: () => gate.promise }));
  const pending = value(host.use(token))[method]!(undefined);
  await flush();
  expect(host.inspect().work[0]!.label).toHaveLength(70008);
  const closing = host.close();
  await flush();
  time.advance(10);
  const error = failure(await closing);
  expect(error.details).toMatchObject({
    work: {
      total: 1,
      items: [{ label: ("storage." + method).slice(0, 160), labelTruncated: true }],
    },
    resources: { total: 1 },
  });
  recorded(host, error);
  expect(new TextEncoder().encode(JSON.stringify(error.details)).length).toBeLessThan(65536);
  gate.resolve(ok());
  await pending;
  await flush();
  expect(host.inspect().work).toEqual([]);
});

it("task finished waits for actual completion after a cancelled outward receipt", async () => {
  const host = create();
  const gate = deferred<Result<void>>();
  const task = value(host.startTask({ label: "drain", run: () => gate.promise }));
  await flush();
  value(task.cancel());
  expect(await host.wait(task)).toMatchObject({ ok: false, error: { code: "cancelled" } });
  let finished = false;
  void task.finished.then(() => {
    finished = true;
  });
  await flush();
  expect(finished).toBe(false);
  gate.resolve(ok());
  expect(await task.finished).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(task.state).toBe("settled");
});
