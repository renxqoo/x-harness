import { expect, it } from "vitest";
import { createHost, defineChain, defineService } from "../../index";
import type { Result } from "../../index";
import { deferred, text, value } from "../../__test__/helpers";

it.each(["maxCallDepth", "maxActiveCalls"] as const)("a cross-scope dependency cannot discard the caller's %s budget", async limit => {
  const host = value(createHost());
  const leaf = value(defineService<{ run(input: void): Promise<Result<void>> }>({ name: "inherited/leaf", methods: { run: {} } }));
  const entry = value(defineService<{ run(input: void): Promise<Result<void>> }>({ name: "inherited/entry", methods: { run: {} } }));
  let entered = 0;
  try {
    value(await host.install([
      { name: "leaf", provides: { leaf }, setup: ctx => ctx.register(leaf, { async run() { entered += 1; return { ok: true, value: undefined }; } }) },
      { name: "entry", requires: { leaf }, provides: { entry }, setup: ctx => ctx.register(entry, { run(_input, call) { return (call.deps.leaf as { run(input: void): Promise<Result<void>> }).run(undefined); } }) },
    ]));
    const child = value(host.createScope({ label: "limited", limits: { [limit]: 1 } }));
    expect(await value(child.use(entry)).run(undefined)).toMatchObject({ ok: false, error: { code: "resource-limit" } });
    expect(entered).toBe(0);
  } finally { value(await host.close()); }
});

it("cross-scope spawned tasks retain the caller's active task limit until actual completion", async () => {
  const host = value(createHost());
  const entry = value(defineService<{ run(input: void): Promise<Result<number>> }>({ name: "inherited/spawn", methods: { run: {} } }));
  const gate = deferred<void>();
  let peak = 0;
  try {
    value(host.register(entry, { async run(_input, call) {
      const first = value(call.spawn({ label: "first", async run() { await gate.promise; return { ok: true, value: undefined }; } }));
      const second = call.spawn({ label: "second", async run() { await gate.promise; return { ok: true, value: undefined }; } });
      peak = host.inspect().activeTasks;
      gate.resolve();
      value(await call.wait(first));
      return second.ok ? { ok: true, value: 2 } : { ok: true, value: 1 };
    } }));
    const child = value(host.createScope({ label: "limited", limits: { maxActiveTasks: 1 } }));
    expect(await value(child.use(entry)).run(undefined)).toEqual({ ok: true, value: 1 });
    expect(peak).toBe(1);
  } finally { gate.resolve(); value(await host.close()); }
});

it("a dependency chain cannot discard the caller's per-frame continuation budget", async () => {
  const host = value(createHost());
  const chain = value(defineChain({ name: "inherited/chain", input: text, output: text }));
  const entry = value(defineService<{ run(input: void): Promise<Result<string>> }>({ name: "inherited/dispatch", methods: { run: {} } }));
  let entered = 0;
  try {
    value(host.register(chain, input => { entered += 1; return { ok: true, value: input }; }));
    value(host.middleware(chain, async (input, next) => { const first = await next(input); return first.ok ? next(input) : first; }));
    value(await host.install([{ name: "entry", requires: { chain }, provides: { entry }, setup: ctx => ctx.register(entry, { run(_input, call) { return call.dispatch("chain", "input") as Promise<Result<string>>; } }) }]));
    const child = value(host.createScope({ label: "limited", limits: { maxNextCallsPerFrame: 1 } }));
    expect(await value(child.use(entry)).run(undefined)).toMatchObject({ ok: false, error: { code: "resource-limit" } });
    expect(entered).toBe(1);
  } finally { value(await host.close()); }
});

it("a cross-scope waiter cannot discard the caller's active wait budget", async () => {
  const host = value(createHost());
  const release = deferred<void>();
  const target = value(host.startTask({ label: "target", async run() { await release.promise; return { ok: true, value: undefined }; } }));
  const leaf = value(defineService<{ run(input: void): Promise<Result<void>> }>({ name: "inherited/wait-leaf", methods: { run: {} } }));
  const entry = value(defineService<{ run(input: void): Promise<Result<void>> }>({ name: "inherited/wait-entry", methods: { run: {} } }));
  try {
    value(await host.install([
      { name: "leaf", provides: { leaf }, setup: ctx => ctx.register(leaf, { async run(_input, call) {
        const first = call.wait(target);
        const second = call.wait(target);
        release.resolve();
        value(await first);
        return second;
      } }) },
      { name: "entry", requires: { leaf }, provides: { entry }, setup: ctx => ctx.register(entry, { run(_input, call) { return (call.deps.leaf as { run(input: void): Promise<Result<void>> }).run(undefined); } }) },
    ]));
    const child = value(host.createScope({ label: "limited", limits: { maxActiveWaits: 1 } }));
    expect(await value(child.use(entry)).run(undefined)).toMatchObject({ ok: false, error: { code: "resource-limit" } });
    expect(host.inspect().activeWaits).toBe(0);
  } finally { release.resolve(); await target.finished; value(await host.close()); }
});
