import { expect, it } from "vitest";
import { createHost, defineChain, defineGuard } from "../../index";
import type { Host, PluginRef, Result } from "../../index";
import { clock, deferred, flush, text, value } from "../../__test__/helpers";

async function scenario(host: Host, kind: "guard" | "chain") {
  const entered = deferred<void>();
  const release = deferred<void>();
  const state = { alive: true, later: 0 };
  let plugin: PluginRef;
  let dispatch: () => Promise<Result<unknown, unknown>>;
  if (kind === "guard") {
    const token = value(defineGuard({ name: "revoked/guard", input: text }));
    plugin = value(await host.install([{ name: "provider", provides: { token }, setup(ctx) {
      value(ctx.addCleanup(() => { state.alive = false; return { ok: true, value: undefined }; }));
      return { ok: true, value: undefined };
    } }])).plugins[0]!;
    value(host.guard(token, async () => { entered.resolve(); await release.promise; return { ok: true, value: { kind: "allow" } }; }));
    value(host.guard(token, () => { state.later += 1; return { ok: true, value: { kind: "allow" } }; }));
    dispatch = () => host.dispatch(token, "input");
  } else {
    const token = value(defineChain({ name: "revoked/chain", input: text, output: text }));
    plugin = value(await host.install([{ name: "provider", provides: { token }, setup(ctx) {
      value(ctx.addCleanup(() => { state.alive = false; return { ok: true, value: undefined }; }));
      return ctx.register(token, input => { state.later += 1; return { ok: true, value: input }; });
    } }])).plugins[0]!;
    value(host.middleware(token, async (input, next) => { entered.resolve(); await release.promise; return next(input); }));
    dispatch = () => host.dispatch(token, "input");
  }
  return { plugin, state, entered, release, dispatch };
}

it.each(["guard", "chain"] as const)("revoking a %s provider cancels captured dispatch and waits for the actual handler before releasing resources", async kind => {
  const host = value(createHost());
  const current = await scenario(host, kind);
  let receipt: Result<unknown, unknown> | undefined;
  const dispatched = current.dispatch().then(result => { receipt = result; return result; });
  await current.entered.promise;
  let uninstalled = false;
  const uninstalling = host.uninstall(current.plugin).then(result => { uninstalled = true; return result; });
  try {
    await flush();
    expect(receipt).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(uninstalled).toBe(false);
    expect(current.state).toEqual({ alive: true, later: 0 });
    current.release.resolve();
    value(await uninstalling);
    expect(current.state).toEqual({ alive: false, later: 0 });
  } finally { current.release.resolve(); await dispatched; await uninstalling; value(await host.close()); }
});

it.each(["guard", "chain"] as const)("a noncooperative %s handler keeps a revoked provider accounted after close-incomplete", async kind => {
  const time = clock();
  const host = value(createHost({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } }));
  const current = await scenario(host, kind);
  const dispatched = current.dispatch();
  await current.entered.promise;
  const uninstalling = host.uninstall(current.plugin);
  try {
    await flush();
    time.advance(10);
    expect(await uninstalling).toMatchObject({ ok: false, error: { code: "close-incomplete", details: { work: { items: expect.arrayContaining([expect.objectContaining({ label: `revoked/${kind}`, cancelled: true })]) } } } });
    expect(current.state).toEqual({ alive: true, later: 0 });
    expect(host.inspect().activeCalls).toBeGreaterThan(0);
    current.release.resolve();
    await flush();
    expect(current.state).toEqual({ alive: false, later: 0 });
    expect(host.inspect().activeCalls).toBe(0);
  } finally { current.release.resolve(); await dispatched; await uninstalling; await flush(); value(await host.close()); }
});
