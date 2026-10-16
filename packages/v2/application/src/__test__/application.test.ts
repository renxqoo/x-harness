import { expect, it } from "vitest";
import { createApplication } from "../index";
import { definePlugin } from "../../../core/src/index";
import type { Plugin } from "../../../core/src/index";
import { deferred, flush, ok, service, value } from "./helpers";

it("missing required dependencies stay pending and activate when their provider appears", async () => {
  const token = service("store"); const app = value(createApplication()); let reads = 0;
  const consumer = definePlugin({ name: "consumer", requires: { token }, async setup(ctx) { const result = await ctx.deps.token.read(); if (result.ok) reads += 1; return result; } });
  expect(value(await app.setPlugins([consumer])).plugins).toMatchObject([{ name: "consumer", state: "pending", missing: ["store"] }]);
  const provider = definePlugin({ name: "provider", provides: { token }, setup(ctx) { return ctx.service({ token: { async read() { return { ok: true, value: "value" }; } } }); } });
  expect(value(await app.setPlugins([consumer, provider])).plugins.every((entry) => entry.state === "active")).toBe(true); expect(reads).toBe(1);
  value(await app.close());
});

it("provider replacement drains transitive consumers and revokes saved service facades", async () => {
  const a = service("a"); const b = service("b"); const app = value(createApplication()); const log: string[] = [];
  const provider = (text: string) => definePlugin({ name: "provider", provides: { a }, setup(ctx) { value(ctx.addCleanup(() => { log.push(`close-${text}`); return ok(); })); return ctx.service({ a: { async read() { return { ok: true, value: text }; } } }); } });
  const middle = definePlugin({ name: "middle", requires: { a }, provides: { b }, setup(ctx) { value(ctx.addCleanup(() => { log.push("close-middle"); return ok(); })); return ctx.service({ b: { async read(_input, call) { return call.deps.a.read(); } } }); } });
  const leaf = definePlugin({ name: "leaf", requires: { b }, setup(ctx) { return ctx.addCleanup(() => { log.push("close-leaf"); return ok(); }); } });
  const first = provider("one"); value(await app.setPlugins([leaf, middle, first])); const saved = value(app.use(b)); expect(value(await saved.read())).toBe("one");
  value(await app.setPlugins([leaf, middle, provider("two")])); expect(log).toEqual(["close-leaf", "close-middle", "close-one"]);
  expect((await saved.read()).ok).toBe(false); expect(value(await value(app.use(b)).read())).toBe("two"); value(await app.close());
});

it("optional dependencies reassemble on appearance and disappearance", async () => {
  const token = service("optional"); const app = value(createApplication()); const seen: boolean[] = [];
  const consumer = definePlugin({ name: "consumer", optional: { token }, setup(ctx) { seen.push(!!ctx.deps.token); return ok(); } });
  const provider = definePlugin({ name: "provider", provides: { token }, setup(ctx) { return ctx.service({ token: { async read() { return { ok: true, value: "yes" }; } } }); } });
  value(await app.setPlugins([consumer])); value(await app.setPlugins([consumer, provider])); value(await app.setPlugins([consumer]));
  expect(seen).toEqual([false, true, false]); value(await app.close());
});

it("unchanged declarations preserve instances and changed snapshots of mutable declarations restart", async () => {
  const app = value(createApplication()); let starts = 0; const plugin: Plugin = { name: "mutable", setup() { starts += 1; return ok(); } };
  const first = value(await app.setPlugins([plugin])).plugins[0]!.instanceId;
  expect(value(await app.setPlugins([plugin])).plugins[0]!.instanceId).toBe(first);
  Object.assign(plugin, { setup() { starts += 2; return ok(); } });
  expect(value(await app.setPlugins([plugin])).plugins[0]!.instanceId).not.toBe(first); expect(starts).toBe(3); value(await app.close());
});

it("invalid graphs are rejected before existing plugins are stopped", async () => {
  const app = value(createApplication()); const a = service("same"); const alien = service("same"); const b = service("other");
  const plugin = { name: "stable", setup: ok }; value(await app.setPlugins([plugin])); const before = app.snapshot();
  const invalid = [null, [null], [{ name: "broken", setup: ok, requires: { fake: { kind: "service", name: "fake" } } }],
    [plugin, plugin], [{ name: "a", setup: ok, provides: { a } }, { name: "b", setup: ok, provides: { a } }],
    [{ name: "a", setup: ok, provides: { a } }, { name: "b", setup: ok, requires: { alien } }],
    [{ name: "a", setup: ok, provides: { a }, requires: { b } }, { name: "b", setup: ok, provides: { b }, optional: { a } }]];
  for (const input of invalid) { expect((await app.setPlugins(input as readonly Plugin[])).ok).toBe(false); expect(app.snapshot()).toEqual(before); }
  const hostile = Object.defineProperty([], "0", { get() { throw new Error("getter"); } }); hostile.length = 1;
  expect((await app.setPlugins(hostile as readonly Plugin[])).ok).toBe(false);
  expect((await app.setPlugins(new Proxy([], { get() { throw new Error("proxy"); } }))).ok).toBe(false); value(await app.close());
});

it("independent activation failures are visible and refresh retries them", async () => {
  const app = value(createApplication()); let fail = true; const token = service("failed");
  const broken = { name: "broken", provides: { token }, setup() { if (fail) throw new Error("private"); return { ok: false, error: { source: "core", code: "activation-failed", message: "failed" } } as const; } };
  const dependent = { name: "dependent", requires: { token }, setup: ok }; const good = { name: "good", setup: ok };
  const result = value(await app.setPlugins([dependent, broken, good])); expect(result.plugins.map((entry) => entry.state)).toEqual(["failed", "pending", "active"]);
  fail = false; expect(value(await app.refresh()).plugins[0]!.state).toBe("failed"); expect(JSON.stringify(app.snapshot())).not.toContain("private");
  const repaired = definePlugin({ name: "broken", provides: { token }, setup(ctx) { return ctx.service({ token: { async read() { return { ok: true, value: "ready" }; } } }); } });
  expect(value(await app.setPlugins([dependent, repaired, good])).plugins.every((entry) => entry.state === "active")).toBe(true); value(await app.close());
});

it("incomplete actual work blocks replacement until refresh sees the old instance drained", async () => {
  const token = service("slow"); const gate = deferred<{ ok: true; value: string }>(); const app = value(createApplication({ host: { limits: { closeTimeoutMs: 10 } } }));
  const old = definePlugin({ name: "provider", provides: { token }, setup(ctx) { return ctx.service({ token: { read: () => gate.promise } }); } });
  const next = definePlugin({ name: "provider", provides: { token }, setup(ctx) { return ctx.service({ token: { async read() { return { ok: true, value: "new" }; } } }); } });
  value(await app.setPlugins([old])); const pending = value(app.use(token)).read(); await flush();
  expect(await app.setPlugins([next])).toMatchObject({ ok: false, error: { code: "close-incomplete" } });
  expect((await app.refresh()).ok).toBe(false); expect((await pending).ok).toBe(false);
  gate.resolve({ ok: true, value: "old" }); await flush(); value(await app.refresh()); expect(value(await value(app.use(token)).read())).toBe("new"); value(await app.close());
});

it("failed cleanup blocks replacement and is never reported as a healthy application", async () => {
  const app = value(createApplication()); const old = definePlugin({ name: "plugin", setup(ctx) { return ctx.addCleanup(() => { throw new Error("private"); }); } });
  value(await app.setPlugins([old])); expect((await app.setPlugins([{ name: "plugin", setup: ok }])).ok).toBe(false); expect((await app.refresh()).ok).toBe(false);
  expect(app.snapshot().plugins[0]).toMatchObject({ state: "failed", error: { code: "close-incomplete" } });
  expect((await app.close()).ok).toBe(false); expect(app.snapshot().state).toBe("close-failed");
});

it("operation queue is bounded and close cancels the active assembly immediately", async () => {
  const gate = deferred<ReturnType<typeof ok>>(); const app = value(createApplication({ maxPendingOperations: 1 }));
  const active = app.setPlugins([{ name: "blocked", setup: () => gate.promise }]); await flush(); const queued = app.setPlugins([]);
  expect(await app.refresh()).toMatchObject({ ok: false, error: { code: "resource-limit" } }); const closing = app.close(); gate.resolve(ok());
  expect((await active).ok).toBe(false); expect((await queued).ok).toBe(false); value(await closing); expect(app.close()).toBe(closing);
  expect((await app.refresh()).ok).toBe(false); expect((await app.setPlugins([])).ok).toBe(false); expect(app.snapshot().state).toBe("closed");
});

it("options and plugin limits reject invalid input without creating application work", async () => {
  for (const options of [null, { extra: true }, { maxPlugins: 0 }, { maxPendingOperations: 10001 }, { host: { extra: true } }]) expect(createApplication(options as Parameters<typeof createApplication>[0]).ok).toBe(false);
  const app = value(createApplication({ maxPlugins: 1 })); expect((await app.setPlugins([{ name: "a", setup: ok }, { name: "b", setup: ok }])).ok).toBe(false); value(await app.close());
});

it("application dispatch and diagnostics use the owned host and remain inspectable after close", async () => {
  const { defineChain } = await import("../../../core/src/index");
  const token = value(defineChain<string, string>({ name: "application/route", input: (input) => ({ ok: true, value: String(input) }), output: (output) => ({ ok: true, value: String(output) }) }));
  const app = value(createApplication()); expect(app.diagnostics()).toEqual([]);
  const plugin = definePlugin({ name: "router", provides: { token }, setup(ctx) { return ctx.handle("token", (input) => ({ ok: true, value: input.toUpperCase() })); } });
  value(await app.setPlugins([plugin])); expect(value(await app.dispatch(token, "hello"))).toBe("HELLO");
  value(await app.setPlugins([])); expect((await app.dispatch(token, "gone")).ok).toBe(false); expect(app.diagnostics().length).toBeGreaterThan(0);
  value(await app.close()); expect(app.inspect().plugins).toEqual([]); expect(app.diagnostics().length).toBeGreaterThan(0);
});
