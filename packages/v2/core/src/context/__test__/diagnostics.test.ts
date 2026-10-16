import { afterEach, expect, it } from "vitest";
import { defineEvent, defineService } from "../../index";
import type { Context, CoreFault, Diagnostic, Host, Result } from "../../index";
import { clock, deferred, flush, root, text, value } from "../../__test__/helpers";

const hosts: Host[] = [];
const create = (options?: Parameters<typeof root>[0]) => { const host = root(options); hosts.push(host); return host; };
const service = (name: string) => value(defineService<{ run(input: string): Promise<Result<string>> }>({ name, methods: { run: {} } }));
const ok = (): Result<void> => ({ ok: true, value: undefined });
const implementation = { run: (input: string): Promise<Result<string>> => Promise.resolve({ ok: true, value: input }) };
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); });

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

it("missing dependency names the plugin and definition before setup executes", async () => {
  const host = create(); const token = service("database"); let called = false;
  const error = failure(await host.install([{ name: "users", requires: { database: token }, setup() { called = true; return ok(); } }]));
  expect(error).toMatchObject({ code: "missing-dependency", scopeId: "root", pluginName: "users", details: { definition: "service/database" } });
  recorded(host, error); expect(called).toBe(false); expect(host.inspect().plugins).toEqual([]);
});

it("dependency snapshots distinguish fixed providers and absent optional declarations across scopes", async () => {
  const host = create(); const token = service("database"); const optional = service("cache");
  value(await host.install([{ name: "storage", provides: { token }, setup: (ctx) => ctx.register(token, implementation) }]));
  const child = value(host.createScope({ label: "child" }));
  value(await host.install([{ name: "users", requires: { database: token }, optional: { cache: optional }, setup: ok }], { scope: child }));
  const sibling = value(host.createScope({ label: "sibling" }));
  value(await host.install([{ name: "storage", provides: { token }, setup: (ctx) => ctx.register(token, implementation, { shadow: true }) }], { scope: sibling }));
  const snapshot = host.inspect(); const consumer = snapshot.plugins.find((plugin) => plugin.ref.name === "users")!;
  expect(consumer.dependencies).toEqual([
    { name: "database", definition: { kind: "service", name: "database" }, optional: false, provider: snapshot.plugins[0]!.provides[0] },
    { name: "cache", definition: { kind: "service", name: "cache" }, optional: true, provider: null },
  ]);
  expect(consumer.dependencies[0]!.provider!.owner.scopeId).toBe("root");
  expect(snapshot.plugins[0]!.ref.instanceId).not.toBe(snapshot.plugins[2]!.ref.instanceId);
  expect(consumer.dependencies[0]!.definition).not.toBe(token);
  expect(Object.isFrozen(consumer.dependencies[0]!.provider!.owner)).toBe(true);
  expect(Object.isFrozen(consumer.dependencies)).toBe(true); expect(Object.isFrozen(snapshot.plugins)).toBe(true);
});

it("uninstall and self-close identify the consumer without stopping the provider", async () => {
  const host = create(); const token = service("storage"); let context!: Context;
  const installed = value(await host.install([
    { name: "storage", provides: { token }, setup(ctx) { context = ctx; return ctx.register(token, implementation); } },
    { name: "users", requires: { token }, setup: ok },
  ]));
  for (const result of [await host.uninstall(installed.plugins[0]!), context.requestClose()]) {
    const error = failure(result);
    expect(error).toMatchObject({ code: "plugin-in-use", pluginName: "storage", details: {
      provider: { definition: { kind: "service", name: "storage" }, owner: { pluginName: "storage" } },
      consumers: { total: 1, omitted: 0, items: [{ pluginName: "users" }] },
    } });
    recorded(host, error);
  }
  expect(context.signal.aborted).toBe(false); expect(value(await value(host.use(token)).run("live"))).toBe("live");
});

it("failed cleanup pins retain resource ownership without leaking connection values", async () => {
  const host = create(); const token = service("storage");
  const installed = value(await host.install([{ name: "storage", provides: { token }, setup: (ctx) => ctx.register(token, implementation) }]));
  const child = value(host.createScope({ label: "child" }));
  value(await host.install([{ name: "consumer", requires: { token }, setup(ctx) {
    return ctx.resource({ open: () => ({ ok: true, value: "secret connection" }), close: () => ({ ok: false, error: { source: "core", code: "cleanup-failed", message: "private exception" } }) });
  } }], { scope: child }));
  failure(await host.closeScope(child)); const error = failure(await host.uninstall(installed.plugins[0]!, { cascade: true }));
  expect(["close-incomplete", "plugin-in-use"]).toContain(error.code); recorded(host, error);
  expect(host.inspect().resources.some((resource) => resource.state === "failed" && resource.owner.pluginName === "consumer")).toBe(true);
  expect(JSON.stringify({ inspection: host.inspect(), diagnostics: host.diagnostics() })).not.toMatch(/secret connection|private exception/);
});

it("provider disposer identifies its cleanup pins and remains usable after refusal", async () => {
  const host = create(); const token = service("storage"); const dispose = value(host.register(token, implementation));
  const cleanup = value(host.addCleanup(ok)); const error = failure(await dispose());
  expect(error).toMatchObject({ code: "plugin-in-use", details: { resources: { total: 1, items: [{ kind: "cleanup", owner: { id: "host" } }] } } });
  recorded(host, error); value(await cleanup()); value(await dispose()); expect(host.inspect().resources).toEqual([]);
});

it("inspection preserves task labels and parent waits after cancellation until actual completion", async () => {
  const host = create(); const gate = deferred<Result<void>>();
  const parent = value(host.startTask({ label: "parent", run(call) { value(call.spawn({ label: "child", run: () => gate.promise })); return ok(); } }));
  await flush(); const before = host.inspect(); expect(before.work).toHaveLength(2);
  const child = before.work.find((work) => work.label === "child")!;
  expect(before.work.find((work) => work.id === parent.id)).toMatchObject({ bodyComplete: true, waitingFor: [child.id] });
  expect(child).toMatchObject({ parentId: parent.id, kind: "task", phase: "business", executor: { kind: "host" }, resourceOwner: { id: "host" } });
  value(parent.cancel()); expect(host.inspect().work.every((work) => work.cancelled)).toBe(true);
  expect(before.work.every((work) => !work.cancelled)).toBe(true); expect(Object.isFrozen(child.waitingFor)).toBe(true);
  gate.resolve(ok()); await flush(); expect(host.inspect().work).toEqual([]); expect(before.work).toHaveLength(2);
});

it("inspection exposes explicit waits and removes them after completion", async () => {
  const host = create(); const gate = deferred<Result<void>>();
  const target = value(host.startTask({ label: "target", run: () => gate.promise }));
  const waiter = value(host.startTask({ label: "waiter", run: (call) => call.wait(target) })); await flush();
  expect(host.inspect().work.find((work) => work.id === waiter.id)?.waitingFor).toEqual([target.id]);
  gate.resolve(ok()); value(await host.wait(waiter)); expect(host.inspect().activeWaits).toBe(0); expect(host.inspect().work).toEqual([]);
});

it("resource snapshots distinguish registration paths and omit actual resource values", async () => {
  const host = create(); const token = service("storage"); const event = value(defineEvent({ name: "updated", payload: text }));
  value(host.register(token, implementation)); value(host.register(event)); value(host.on(event, () => {})); value(host.addCleanup(ok));
  value(await host.resource({ open: () => ({ ok: true, value: { secret: "connection value" } }), close: ok }));
  const resources = host.inspect().resources;
  expect(new Set(resources.map((resource) => resource.kind))).toEqual(new Set(["provider", "registration", "cleanup", "resource"]));
  expect(resources.every((resource) => resource.state === "active" && resource.owner.id === "host" && resource.executor.id === "host")).toBe(true);
  expect(Object.isFrozen(resources[0]!.dependencies[0]!.definition)).toBe(true); expect(JSON.stringify(resources)).not.toContain("connection value");
  value(await host.close()); expect(host.inspect().resources).toEqual([]); expect(resources).toHaveLength(5);
});

it("scope close details exclude siblings and stay frozen after late convergence", async () => {
  const time = clock(); const host = create({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } });
  const a = value(host.createScope({ label: "a" })); const b = value(host.createScope({ label: "b" }));
  const gate = deferred<Result<void>>(); const other = deferred<Result<void>>();
  const task = value(a.startTask({ label: "blocked-a", run: () => gate.promise })); value(b.startTask({ label: "blocked-b", run: () => other.promise }));
  await flush(); const closing = host.closeScope(a); await flush(); time.advance(10); const error = failure(await closing);
  expect(error).toMatchObject({ code: "close-incomplete", scopeId: a.scopeId, details: {
    work: { total: 1, omitted: 0, items: [{ id: task.id, label: "blocked-a", cancelled: true }] }, resources: { total: 0, omitted: 0, items: [] },
  } });
  recorded(host, error); const saved = JSON.stringify(error); gate.resolve(ok()); await flush();
  expect(a.scopeState).toBe("closed"); expect(JSON.stringify(error)).toBe(saved); other.resolve(ok()); await flush();
});

it("plugin uninstall deadline identifies tasks from the cascade selection", async () => {
  const time = clock(); const host = create({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } }); const token = service("storage"); const gate = deferred<Result<void>>();
  const installed = value(await host.install([
    { name: "storage", provides: { token }, setup: (ctx) => ctx.register(token, implementation) },
    { name: "consumer", requires: { token }, setup(ctx) { return ctx.startTask({ label: "refresh", run: () => gate.promise }); } },
  ]));
  await flush(); const closing = host.uninstall(installed.plugins[0]!, { cascade: true }); await flush(); time.advance(10); const error = failure(await closing);
  expect(error).toMatchObject({ code: "close-incomplete", pluginName: "storage", details: { work: { total: 1, items: [{ label: "refresh", executor: { pluginName: "consumer" } }] } } });
  recorded(host, error); gate.resolve(ok()); await flush(); expect(host.inspect().plugins).toEqual([]);
});

it("manual cleanup deadline identifies its closing resource and allows late release", async () => {
  const time = clock(); const host = create({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } }); const gate = deferred<Result<void>>();
  const dispose = value(host.addCleanup(() => gate.promise)); const id = host.inspect().resources[0]!.id; const releasing = dispose(); await flush();
  expect(host.inspect().resources[0]!.state).toBe("closing"); time.advance(10); const error = failure(await releasing);
  expect(error).toMatchObject({ code: "close-incomplete", details: { resourceId: id, resources: { total: 1, items: [{ id, kind: "cleanup", state: "closing", owner: { id: "host" } }] } } });
  recorded(host, error); gate.resolve(ok()); await flush(); expect(host.inspect().resources).toEqual([]);
});

it("diagnostic samples report omitted entries while inspect keeps all bounded work", async () => {
  const time = clock(); const host = create({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } }); const gate = deferred<Result<void>>();
  for (let index = 0; index < 12; index += 1) value(host.startTask({ label: "界".repeat(160), run: () => gate.promise }));
  await flush(); const closing = host.close(); await flush(); time.advance(10); const error = failure(await closing);
  expect(error.details).toMatchObject({ work: { total: 12, omitted: 4, items: expect.any(Array) } });
  const details = error.details as { work: { items: unknown[] } }; expect(details.work.items).toHaveLength(8);
  expect(new TextEncoder().encode(JSON.stringify(error.details)).length).toBeLessThan(65536);
  expect(host.inspect().work).toHaveLength(12); expect(Object.isFrozen(details.work.items)).toBe(true); gate.resolve(ok()); await flush();
});

it("sink mutation and reentry cannot change the returned diagnostic details", async () => {
  let host!: Host; const token = service("missing"); const seen: Diagnostic[] = [];
  host = create({ onDiagnostic(diagnostic) { seen.push(diagnostic); host.use(token); Reflect.set(diagnostic.details as object, "definition", "corrupt"); throw new Error("private sink"); } });
  const error = failure(await host.install([{ name: "consumer", requires: { token }, setup: ok }]));
  expect(seen).toHaveLength(1); expect(error.details).toEqual({ definition: "service/missing" }); recorded(host, error);
  expect(JSON.stringify(host.diagnostics())).not.toContain("private sink");
});

it("invalid token diagnostic paths never invoke untrusted metadata getters", () => {
  const host = create(); let reads = 0;
  const token = Object.defineProperties({}, { kind: { get() { reads += 1; throw new Error("private getter"); } }, name: { get() { reads += 1; throw new Error("private getter"); } } });
  expect(() => host.use(token as Parameters<Host["use"]>[0])).not.toThrow(); expect(reads).toBe(0);
  expect(JSON.stringify(host.diagnostics())).not.toContain("private getter");
});


it.each(["scope", "plugin"] as const)("late %s close completion cannot emit a second timeout diagnostic", async (mode) => {
  const time = clock(); const host = create({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } }); const gate = deferred<Result<void>>();
  const installed = value(await host.install([{ name: "blocked", setup(ctx) { return ctx.startTask({ label: "drain", run: () => gate.promise }); } }]));
  await flush(); const closing = mode === "scope" ? host.close() : host.uninstall(installed.plugins[0]!);
  await flush(); time.advance(10); const error = failure(await closing); recorded(host, error);
  expect(host.diagnostics().filter((item) => item.code === "close-incomplete")).toHaveLength(1);
  gate.resolve(ok()); await flush();
  expect(host.diagnostics().filter((item) => item.code === "close-incomplete")).toHaveLength(1);
});

it("pending service methods show the executor and the caller-owned resource separately", async () => {
  const host = create(); const token = service("database"); const gate = deferred<Result<string>>();
  value(await host.install([{ name: "storage", provides: { token }, setup(ctx) { return ctx.register(token, { run: () => gate.promise }); } }]));
  const child = value(host.createScope({ label: "request" })); const pending = value(child.use(token)).run("private input"); await flush();
  expect(host.inspect().work).toMatchObject([{ label: "database.run", kind: "call", executor: { pluginName: "storage", scopeId: "root" }, resourceOwner: { kind: "host", scopeId: child.scopeId } }]);
  expect(JSON.stringify(host.inspect())).not.toContain("private input"); gate.resolve({ ok: true, value: "private output" }); value(await pending);
  expect(host.inspect().work).toEqual([]);
});

it("failed cleanup summaries sample resources and retain their failed state", async () => {
  const host = create();
  for (let index = 0; index < 10; index += 1) value(host.addCleanup(() => { throw new Error("private disposer"); }));
  const error = failure(await host.close());
  expect(error.details).toMatchObject({ resources: { total: 10, omitted: 2, items: expect.arrayContaining([{ id: expect.any(String), kind: "cleanup", state: "failed", owner: expect.any(Object), executor: expect.any(Object) }]) } });
  recorded(host, error); expect(host.inspect().resources.every((resource) => resource.state === "failed")).toBe(true);
  expect(JSON.stringify(host.diagnostics())).not.toContain("private disposer");
});

it.each(["live", "closed"])("retained diagnostic snapshots release retired tokens in a %s host", async (mode) => {
  const child = Bun.spawn(["bun", new URL("./diagnostics.gc-case.ts", import.meta.url).pathname, mode], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_JSC_useJIT: "false" },
  });
  const timeout = setTimeout(() => child.kill(), 5000);
  try {
    const [output, errors, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(errors).toBe(""); expect(status).toBe(0);
    expect(JSON.parse(output)).toEqual({ tokenCollected: true, kernelCollected: mode === "closed" });
  } finally { clearTimeout(timeout); child.kill(); }
});

it.each([false, true])("host-owned pins identify their scope when cascade is %s", async (cascade) => {
  const host = create(); const token = service("connection");
  const installed = value(await host.install([{ name: "storage", provides: { token }, setup(ctx) {
    return ctx.register(token, { run(input, call) { const effect = call.effect(ok); return Promise.resolve(effect.ok ? { ok: true, value: input } : effect); } });
  } }]));
  const child = value(host.createScope({ label: "request" })); value(await value(child.use(token)).run("input"));
  const resource = host.inspect().resources.find((item) => item.owner.scopeId === child.scopeId)!;
  expect(resource).toMatchObject({ kind: "cleanup", owner: { kind: "host", scopeId: child.scopeId }, executor: { pluginName: "storage" } });
  const error = failure(await host.uninstall(installed.plugins[0]!, { cascade }));
  expect(error).toMatchObject({ code: "plugin-in-use", details: { resources: { total: 1, items: [{ id: resource.id, owner: { scopeId: child.scopeId } }] } } });
  recorded(host, error); expect(host.inspect().plugins[0]!.state).toBe("active");
  value(await host.closeScope(child)); value(await host.uninstall(installed.plugins[0]!));
});


it("manual cleanup failures include only that resource's pending service calls", async () => {
  const time = clock(); const host = create({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } });
  const storage = service("storage"); const other = service("other");
  const first = deferred<Result<string>>(); const second = deferred<Result<string>>();
  value(host.register(storage, { run: () => first.promise })); value(host.register(other, { run: () => second.promise }));
  const offStorage = value(host.addCleanup(async (cleanup) => { await value(cleanup.context.use(storage)).run("input"); return ok(); }));
  const offOther = value(host.addCleanup(async (cleanup) => { await value(cleanup.context.use(other)).run("input"); return ok(); }));
  const releasingStorage = offStorage(); const releasingOther = offOther(); await flush();
  expect(host.inspect().work).toHaveLength(2); time.advance(10);
  const error = failure(await releasingStorage); const otherError = failure(await releasingOther);
  expect(error.details).toMatchObject({ work: { total: 1, items: [{ label: "storage.run", phase: "cleanup" }] } });
  expect(otherError.details).toMatchObject({ work: { total: 1, items: [{ label: "other.run", phase: "cleanup" }] } });
  recorded(host, error); recorded(host, otherError);
  first.resolve({ ok: true, value: "done" }); second.resolve({ ok: true, value: "done" }); await flush();
  expect(host.inspect().work).toEqual([]); value(await host.close());
});

it("throwing timer cancellation cannot leave scope close pending or unhandled", async () => {
  const time = clock(); const host = create({ scheduler: {
    now: () => time.scheduler.now(),
    delay(callback, duration) { const cancel = time.scheduler.delay(callback, duration); return () => { cancel(); throw new Error("private cancellation"); }; },
  } });
  value(await host.close()); expect(host.inspect().state).toBe("closed"); expect(time.timers.size).toBe(0);
});


it("long service method names cannot discard the entire close diagnostic", async () => {
  const time = clock(); const host = create({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } });
  const method = "r".repeat(70000); const gate = deferred<Result<void>>();
  const token = value(defineService<Record<string, (input: void) => Promise<Result<void>>>>({ name: "storage", methods: { [method]: {} } }));
  value(host.register(token, { [method]: () => gate.promise })); const pending = value(host.use(token))[method]!(undefined); await flush();
  expect(host.inspect().work[0]!.label).toHaveLength(70008);
  const closing = host.close(); await flush(); time.advance(10); const error = failure(await closing);
  expect(error.details).toMatchObject({ work: { total: 1, items: [{ label: ("storage." + method).slice(0, 160), labelTruncated: true }] }, resources: { total: 1 } });
  recorded(host, error); expect(new TextEncoder().encode(JSON.stringify(error.details)).length).toBeLessThan(65536);
  gate.resolve(ok()); await pending; await flush(); expect(host.inspect().work).toEqual([]);
});

it("task finished waits for actual completion after a cancelled outward receipt", async () => {
  const host = create(); const gate = deferred<Result<void>>();
  const task = value(host.startTask({ label: "drain", run: () => gate.promise })); await flush(); value(task.cancel());
  expect(await host.wait(task)).toMatchObject({ ok: false, error: { code: "cancelled" } });
  let finished = false; void task.finished.then(() => { finished = true; }); await flush(); expect(finished).toBe(false);
  gate.resolve(ok()); expect(await task.finished).toMatchObject({ ok: false, error: { code: "cancelled" } }); expect(task.state).toBe("settled");
});
