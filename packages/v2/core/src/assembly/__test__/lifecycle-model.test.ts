import { expect, it } from "vitest";
import { defineChain, defineEvent, definePlugin, defineService } from "../../index";
import type { InstallReport, Result } from "../../index";
import { deferred, flush, root, text, value } from "../../__test__/helpers";

it.each([19, 2026, 65537])("seed %i preserves lifecycle accounting across mixed online operations", async (seed) => {
  const app = root();
  const service = value(defineService<{ run(input: string): Promise<Result<string>> }>({ name: "model/service", methods: { run: {} } }));
  const chain = value(defineChain({ name: "model/chain", input: text, output: text }));
  const changed = value(defineEvent({ name: "model/changed", payload: text }));
  let generation = 0;
  let acquired = 0;
  let released = 0;
  let delivered = 0;
  let publish!: (input: string) => unknown;
  let installed: InstallReport | undefined;
  const retired: { run(input: string): Promise<Result<string>> }[] = [];
  let state = seed;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const install = async () => {
    const version = ++generation;
    installed = value(await app.install([
      definePlugin({ name: "listener", requires: { chain, changed }, setup(ctx) {
        const middleware = ctx.middleware("chain", (input, next) => next(input + "!"));
        if (!middleware.ok) return middleware;
        return ctx.on("changed", () => { delivered += 1; });
      } }),
      definePlugin({ name: "provider", provides: { service, chain, changed }, async setup(ctx) {
        const allocated = await ctx.resource({ open() { acquired += 1; return { ok: true, value: version }; }, close() { released += 1; return { ok: true, value: undefined }; } });
        if (!allocated.ok) return allocated;
        publish = (input) => ctx.emit("changed", input);
        const handled = ctx.handle("chain", (input) => ({ ok: true, value: input }));
        if (!handled.ok) return handled;
        return ctx.service({ service: { async run(input) { return { ok: true, value: `${allocated.value}:${input}` }; } } });
      } }),
    ]));
  };
  const unload = async () => {
    if (!installed) return;
    retired.push(value(app.use(service)));
    const provider = installed.plugins.find((plugin) => plugin.name === "provider")!;
    expect(await app.uninstall(provider)).toMatchObject({ ok: false, error: { code: "plugin-in-use" } });
    value(await app.uninstall(provider, { cascade: true }));
    installed = undefined;
  };
  try {
    for (let step = 0; step < 128; step += 1) {
      const action = (random() >>> 16) % 8;
      if (!installed) {
        expect(app.use(service).ok).toBe(false);
        await install();
      } else if (action === 0) {
        await unload();
      } else if (action === 1) {
        expect(value(await value(app.use(service)).run("input"))).toBe(`${generation}:input`);
      } else if (action === 2) {
        expect(value(await app.dispatch(chain, "input"))).toBe("input!");
      } else if (action === 3) {
        const before = delivered;
        expect(publish("input")).toMatchObject({ ok: true });
        await flush();
        expect(delivered).toBe(before + 1);
      } else if (action === 4) {
        const gate = deferred<Result<void>>();
        const entered = deferred<void>();
        const task = value(app.startTask({ label: "cancelled", async run() { entered.resolve(); return gate.promise; } }));
        await entered.promise;
        value(task.cancel());
        expect(await app.wait(task)).toMatchObject({ ok: false, error: { code: "cancelled" } });
        gate.resolve({ ok: true, value: undefined });
      } else if (action === 5) {
        const failed = await app.install([definePlugin({ name: "failed", async setup(ctx) {
          const allocated = await ctx.resource({ open() { acquired += 1; return { ok: true, value: step }; }, close() { released += 1; return { ok: true, value: undefined }; } });
          return allocated.ok ? { ok: false, error: "controlled" } : allocated;
        } })]);
        expect(failed.ok).toBe(false);
      } else if (action === 6) {
        const child = value(app.createScope({ label: "ephemeral" }));
        value(await value(child.use(service)).run("child"));
        value(await child.resource({ open() { acquired += 1; return { ok: true, value: step }; }, close() { released += 1; return { ok: true, value: undefined }; } }));
        value(await app.closeScope(child));
        expect(child.scopeState).toBe("closed");
      } else {
        for (const facade of retired) expect(await facade.run("stale")).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
      }
      await flush();
      expect(acquired - released).toBe(installed ? 1 : 0);
      expect(app.inspect()).toMatchObject({ state: "open", degraded: false, scopes: 1, effects: installed ? 6 : 0, activeCalls: 0, activeTasks: 0, activeWaits: 0, pendingEvents: 0 });
      expect(app.inspect().plugins).toHaveLength(installed ? 2 : 0);
      expect(app.inspect().serviceLeases).toBeLessThanOrEqual(installed ? 1 : 0);
    }
    await unload();
    value(await app.close());
    expect(acquired).toBe(released);
    expect(app.inspect()).toMatchObject({ state: "closed", scopes: 0, effects: 0, serviceLeases: 0, activeCalls: 0, activeTasks: 0, activeWaits: 0, pendingEvents: 0 });
  } finally { await app.close(); }
});
