import { describe, expect, it, vi } from "vitest";
import { definePlugin, defineService } from "../../index";
import type { PluginInvocation, Result } from "../../index";
import * as dependencyContexts from "../create-dependency-context";
import { clock, deferred, flush, root, value } from "../../__test__/helpers";

const endpoint = (name: string) => value(defineService<{ read(input: string): Promise<Result<string>> }>({ name, methods: { read: {} } }));

describe("lazy invocation dependencies", () => {
  it("unused declarations do not create per-call dependency contexts", async () => {
    const app = root(); const source = endpoint("lazy/source"); const target = endpoint("lazy/target");
    const contexts = vi.spyOn(dependencyContexts, "createDependencyContext");
    let inspectDependencies = false;
    let captured!: PluginInvocation<{ requires: { source: typeof source }; provides: { target: typeof target } }>;
    try {
      value(await app.install([
        definePlugin({ name: "source", provides: { source }, setup(ctx) { return ctx.service({ source: { async read(input) { return { ok: true, value: input }; } } }); } }),
        definePlugin({ name: "target", requires: { source }, provides: { target }, setup(ctx) { return ctx.service({ target: { async read(input, call) {
          captured = call;
          if (inspectDependencies) {
            expect(call.deps).toBe(call.deps); expect(Object.isFrozen(call.deps)).toBe(true); expect(Object.isFrozen(call.deps.source)).toBe(true);
          }
          return { ok: true, value: input };
        } } }); } }),
      ]));
      const consumer = value(app.use(target)); const before = contexts.mock.calls.length;
      for (let i = 0; i < 20; i++) expect(value(await consumer.read("unused"))).toBe("unused");
      expect(contexts.mock.calls.length).toBe(before);
      expect(await captured.deps.source.read("expired")).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(contexts.mock.calls.length).toBe(before);
      inspectDependencies = true; value(await consumer.read("used"));
      expect(contexts.mock.calls.length).toBe(before + 1);
      expect(await captured.deps.source.read("unused facade")).toMatchObject({ ok: false, error: { code: "cancelled" } });
    } finally { contexts.mockRestore(); value(await app.close()); }
  });

  it("first access after unload retains dependency shape and absent optional slots without reviving providers", async () => {
    const app = root(); const source = endpoint("lazy/retired-source"); const missing = endpoint("lazy/missing"); const target = endpoint("lazy/retired-target");
    let captured!: PluginInvocation<{ requires: { source: typeof source }; provides: { target: typeof target }; optional: { missing: typeof missing } }>;
    const installed = value(await app.install([
      definePlugin({ name: "source", provides: { source }, setup(ctx) { return ctx.service({ source: { async read(input) { return { ok: true, value: input }; } } }); } }),
      definePlugin({ name: "target", requires: { source }, optional: { missing }, provides: { target }, setup(ctx) { return ctx.service({ target: { async read(input, call) { captured = call; return { ok: true, value: input }; } } }); } }),
    ]));
    value(await value(app.use(target)).read("capture")); value(await app.uninstall(installed.plugins[0]!, { cascade: true }));
    expect(Object.keys(captured.deps)).toEqual(["source", "missing"]); expect(captured.deps.missing).toBeUndefined();
    expect(Object.isFrozen(captured.deps)).toBe(true); expect(captured.deps).toBe(captured.deps);
    expect(await captured.deps.source.read("expired")).toMatchObject({ ok: false, error: { code: "cancelled" } });
    value(await app.close());
  });

  it("acquired services keep their revocation code while unused dependencies stay cancelled", async () => {
    const app = root(); const source = endpoint("lazy/acquired-source"); const unused = endpoint("lazy/unused-source"); const target = endpoint("lazy/acquired-target");
    let captured!: PluginInvocation<{ requires: { source: typeof source; unused: typeof unused }; provides: { target: typeof target } }>;
    value(await app.install([
      definePlugin({ name: "source", provides: { source, unused }, setup(ctx) { const implementation = { async read(input: string) { return { ok: true as const, value: input }; } }; return ctx.service({ source: implementation, unused: implementation }); } }),
      definePlugin({ name: "target", requires: { source, unused }, provides: { target }, setup(ctx) { return ctx.service({ target: { async read(input, call) { captured = call; return call.deps.source.read(input); } } }); } }),
    ]));
    value(await value(app.use(target)).read("capture"));
    expect(await captured.deps.source.read("expired")).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    expect(await captured.deps.unused.read("expired")).toMatchObject({ ok: false, error: { code: "cancelled" } });
    value(await app.close());
  });

  it("reused declarations keep optional availability isolated between owners", async () => {
    const app = root(); const source = endpoint("lazy/scoped-source"); const target = endpoint("lazy/scoped-target");
    const present = value(app.createScope({ label: "present" })); const absent = value(app.createScope({ label: "absent" }));
    const calls: PluginInvocation<{ provides: { target: typeof target }; optional: { source: typeof source } }>[] = [];
    const consumer = definePlugin({ name: "consumer", optional: { source }, provides: { target }, setup(ctx) { return ctx.service({ target: { async read(input, call) { calls.push(call); return { ok: true, value: input }; } } }); } });
    value(await app.install([definePlugin({ name: "source", provides: { source }, setup(ctx) { return ctx.service({ source: { async read(input) { return { ok: true, value: input }; } } }); } }), consumer], { scope: present }));
    value(await app.install([consumer], { scope: absent }));
    value(await value(present.use(target)).read("present")); value(await value(absent.use(target)).read("absent"));
    expect(calls[0]!.deps.source).toBeDefined(); expect(calls[1]!.deps.source).toBeUndefined();
    expect(await calls[0]!.deps.source!.read("expired")).toMatchObject({ ok: false, error: { code: "cancelled" } });
    value(await app.close());
  });

  it("cleanup service first reads its fixed dependency after the provider has retired", async () => {
    const app = root(); const source = endpoint("lazy/cleanup-source"); const target = endpoint("lazy/cleanup-target");
    let saved!: PluginInvocation<{ requires: { source: typeof source }; provides: { target: typeof target } }>; const phases: string[] = [];
    const installed = value(await app.install([
      definePlugin({ name: "source", provides: { source }, setup(ctx) { return ctx.service({ source: { async read(input, call) { phases.push(call.phase); return { ok: true, value: input }; } } }); } }),
      definePlugin({ name: "target", requires: { source }, provides: { target }, setup(ctx) { return ctx.service({ target: { async read(input, call) { saved = call; await Promise.resolve(); return call.deps.source.read(input); } } }); } }),
      definePlugin({ name: "consumer", requires: { target }, setup(ctx) { return ctx.addCleanup(async (cleanup) => {
        const result = await value(cleanup.context.use(target)).read("cleanup");
        return result.ok ? { ok: true, value: undefined } : result;
      }); } }),
    ]));
    value(await app.uninstall(installed.plugins[0]!, { cascade: true })); expect(phases).toEqual(["cleanup"]);
    expect(await saved.deps.source.read("expired")).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    value(await app.close());
  });

  it("first access after outward timeout cannot admit work while the actual function is still running", async () => {
    const time = clock(); const app = root({ scheduler: time.scheduler, limits: { callTimeoutMs: 10 } });
    const source = endpoint("lazy/timeout-source"); const target = endpoint("lazy/timeout-target"); const gate = deferred<void>();
    let dependencyResult: Result<string> | undefined; let calls = 0;
    value(await app.install([
      definePlugin({ name: "source", provides: { source }, setup(ctx) { return ctx.service({ source: { async read(input) { calls++; return { ok: true, value: input }; } } }); } }),
      definePlugin({ name: "target", requires: { source }, provides: { target }, setup(ctx) { return ctx.service({ target: { async read(input, call) { await gate.promise; dependencyResult = await call.deps.source.read(input); return dependencyResult; } } }); } }),
    ]));
    const running = value(app.use(target)).read("late"); await flush(); time.advance(10);
    expect(await running).toMatchObject({ ok: false, error: { code: "timeout" } }); expect(app.inspect().activeCalls).toBe(1);
    gate.resolve(); await flush(); expect(dependencyResult).toMatchObject({ ok: false, error: { code: "cancelled" } }); expect(calls).toBe(0); expect(app.inspect().activeCalls).toBe(0);
    value(await app.close());
  });
});
