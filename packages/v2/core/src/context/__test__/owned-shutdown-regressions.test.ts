import { expect, it } from "vitest";
import { createHost, defineService } from "../../index";
import type { Context, Result } from "../../index";
import { flush, value } from "../../__test__/helpers";

it("a plugin can request its own shutdown with delegated capabilities in owned descendants", async () => {
  const host = value(createHost());
  const token = value(defineService<{ run(input: void): Promise<Result<void>> }>({ name: "shutdown/owned", methods: { run: {} } }));
  let plugin!: Context;
  let child!: Context;
  value(await host.install([{ name: "owner", provides: { token }, setup(ctx) {
    plugin = ctx;
    const provided = ctx.register(token, { run: () => Promise.resolve({ ok: true, value: undefined }) });
    if (!provided.ok) return provided;
    child = value(ctx.createScope({ label: "owned" }));
    value(child.createScope({ label: "nested" }));
    value(child.addCleanup(() => ({ ok: true, value: undefined })));
    return { ok: true, value: undefined };
  } }]));
  try {
    expect(plugin.requestClose()).toEqual({ ok: true, value: undefined });
    await flush();
    expect(child.scopeState).toBe("closed");
    expect(host.inspect()).toMatchObject({ plugins: [], scopes: 1, effects: 0 });
  } finally { value(await host.close()); }
});

it("a self close request cannot break an independent consumer's declared capability", async () => {
  const host = value(createHost());
  const token = value(defineService<{ run(input: void): Promise<Result<void>> }>({ name: "shutdown/external", methods: { run: {} } }));
  let plugin!: Context;
  value(await host.install([
    { name: "provider", provides: { token }, setup(ctx) { plugin = ctx; return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: undefined }) }); } },
    { name: "consumer", requires: { token }, setup: () => ({ ok: true, value: undefined }) },
  ]));
  try {
    expect(plugin.requestClose()).toMatchObject({ ok: false, error: { code: "plugin-in-use" } });
    expect(host.inspect().plugins).toHaveLength(2);
  } finally { value(await host.close()); }
});
