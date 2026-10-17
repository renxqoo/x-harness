import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createHost, defineService } from "../../index";
import type { Context, HostOptions, Result, Host } from "../../index";

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
function endpoint(name: string) {
  return value(defineService<Endpoint>({ name, methods: { run: {} } }));
}


afterEach(async () => {
  for (const host of roots.splice(0)) await host.close();
});

describe("provider reservations and definition references", () => {
  it("an unconfigured staging slot cannot be claimed by synchronous host provide", async () => {
    const host = setup();
    const token = endpoint("reserved");
    const gate = deferred<void>();
    const installing = host.install([{ name: "provider", provides: { token }, async setup(ctx) {
      await gate.promise;
      return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "plugin" }) });
    } }]);
    await flush();
    expect(host.use(token)).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    expect(host.register(token, { run: () => Promise.resolve({ ok: true, value: "host" }) }))
      .toMatchObject({ ok: false, error: { code: "duplicate-provider" } });
    gate.resolve();
    value(await installing);
    expect(value(await value(host.use(token)).run(undefined))).toBe("plugin");
  });

  it("a failed unconfigured reservation releases both its slot and definition identity", async () => {
    const host = setup({ limits: { maxDefinitions: 1 } });
    const original = endpoint("released");
    expect(await host.install([{ name: "provider", provides: { original }, setup() {
      return { ok: false, error: "rejected" };
    } }])).toMatchObject({ ok: false, error: { code: "activation-failed" } });
    const replacement = endpoint("released");
    value(host.register(replacement, { run: () => Promise.resolve({ ok: true, value: "replacement" }) }));
    expect(host.inspect()).toMatchObject({ plugins: [], effects: 1, degraded: false });
  });

  it("missing optional references reserve capacity until their owner unloads", async () => {
    const host = setup({ limits: { maxDefinitions: 1 } });
    const referenced = endpoint("referenced");
    const other = endpoint("other");
    const installed = value(await host.install([{ name: "consumer", optional: { referenced }, setup() {
      return { ok: true, value: undefined };
    } }]));
    expect(host.register(other, { run: () => Promise.resolve({ ok: true, value: "other" }) }))
      .toMatchObject({ ok: false, error: { code: "resource-limit" } });
    value(await host.uninstall(installed.plugins[0]!));
    value(host.register(other, { run: () => Promise.resolve({ ok: true, value: "other" }) }));
  });

  it("self-requested plugin closure releases definitions even when it provides no capability", async () => {
    const host = setup({ limits: { maxDefinitions: 1 } });
    const original = endpoint("closed-owner");
    let context!: Context;
    value(await host.install([{ name: "consumer", optional: { original }, setup(ctx) {
      context = ctx;
      return { ok: true, value: undefined };
    } }]));
    value(context.requestClose());
    await flush();
    const replacement = endpoint("closed-owner");
    value(host.register(replacement, { run: () => Promise.resolve({ ok: true, value: "replacement" }) }));
  });

  it("provider release cannot remove a definition still referenced by an absent optional binding", async () => {
    const host = setup();
    const original = endpoint("retained");
    let consumer!: Context;
    const installed = value(await host.install([{ name: "consumer", optional: { original }, setup(ctx) {
      consumer = ctx;
      return { ok: true, value: undefined };
    } }]));
    const off = value(host.register(original, { run: () => Promise.resolve({ ok: true, value: "original" }) }));
    expect(consumer.use(original)).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    value(await off());
    const replacement = endpoint("retained");
    expect(host.register(replacement, { run: () => Promise.resolve({ ok: true, value: "replacement" }) }))
      .toMatchObject({ ok: false, error: { code: "definition-conflict" } });
    value(await host.uninstall(installed.plugins[0]!));
    value(host.register(replacement, { run: () => Promise.resolve({ ok: true, value: "replacement" }) }));
  });

  it("conflicting optional identities in one batch reject before activation or reservation", async () => {
    const host = setup({ limits: { maxDefinitions: 1 } });
    const a = endpoint("same-name");
    const b = endpoint("same-name");
    let activated = false;
    expect(await host.install([{ name: "consumer", optional: { a, b }, setup() {
      activated = true;
      return { ok: true, value: undefined };
    } }])).toMatchObject({ ok: false, error: { code: "definition-conflict" } });
    expect(activated).toBe(false);
    value(host.register(a, { run: () => Promise.resolve({ ok: true, value: "available" }) }));
  });

  it("parent provider appearing during activation cannot silently introduce implicit shadowing", async () => {
    const host = setup();
    const child = value(host.createScope({ label: "child" }));
    const token = endpoint("ancestor-race");
    const gate = deferred<void>();
    const installing = host.install([{ name: "local", provides: { token }, async setup(ctx) {
      value(ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "child" }) }));
      await gate.promise;
      return { ok: true, value: undefined };
    } }], { scope: child });
    await flush();
    value(host.register(token, { run: () => Promise.resolve({ ok: true, value: "ancestor" }) }));
    gate.resolve();
    expect(await installing).toMatchObject({ ok: false, error: { code: "duplicate-provider" } });
    expect(value(await value(child.use(token)).run(undefined))).toBe("ancestor");
    expect(host.inspect()).toMatchObject({ plugins: [], effects: 1, degraded: false });
  });

  it("explicit shadow reservation remains valid when an ancestor provider appears before commit", async () => {
    const host = setup();
    const child = value(host.createScope({ label: "child" }));
    const token = endpoint("explicit-shadow");
    const gate = deferred<void>();
    const installing = host.install([{ name: "local", provides: { token }, async setup(ctx) {
      value(ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "child" }) }, { shadow: true }));
      await gate.promise;
      return { ok: true, value: undefined };
    } }], { scope: child });
    await flush();
    value(host.register(token, { run: () => Promise.resolve({ ok: true, value: "ancestor" }) }));
    gate.resolve();
    value(await installing);
    expect(value(await value(child.use(token)).run(undefined))).toBe("child");
    expect(value(await value(host.use(token)).run(undefined))).toBe("ancestor");
  });

  it("unload release counts cannot be polluted by root-owned concurrent registrations", async () => {
    const host = setup();
    const gate = deferred<void>();
    let cleaning = false;
    const loaded = value(await host.install([{ name: "releasing", setup(ctx) {
      return ctx.addCleanup(async () => {
        cleaning = true;
        await gate.promise;
        return { ok: true, value: undefined };
      });
    } }]));
    const unloading = host.uninstall(loaded.plugins[0]!);
    await flush();
    expect(cleaning).toBe(true);
    value(host.addCleanup(() => ({ ok: true, value: undefined })));
    value(host.addCleanup(() => ({ ok: true, value: undefined })));
    gate.resolve();
    const receipt = value(await unloading);
    expect(receipt.releasedEffects).toBe(1);
    expect(host.inspect()).toMatchObject({ effects: 2, plugins: [] });
  });

  it("a failed staging provide keeps its slot reserved until activation rolls back", async () => {
    const host = setup({ limits: { maxEffects: 1 } });
    const occupied = value(host.addCleanup(() => ({ ok: true, value: undefined })));
    const token = endpoint("failed-reservation");
    const gate = deferred<void>();
    let refusal: Result<unknown> | undefined;
    const installing = host.install([{ name: "provider", provides: { token }, async setup(ctx) {
      const provided = ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "plugin" }) });
      refusal = provided;
      await gate.promise;
      return provided;
    } }]);
    await flush();
    value(await occupied());
    const competing = host.register(token, { run: () => Promise.resolve({ ok: true, value: "host" }) });
    gate.resolve();
    expect(await installing).toMatchObject({ ok: false, error: { code: "resource-limit" } });
    expect(refusal).toMatchObject({ ok: false, error: { code: "resource-limit" } });
    expect(competing).toMatchObject({ ok: false, error: { code: "duplicate-provider" } });
    value(host.register(token, { run: () => Promise.resolve({ ok: true, value: "host" }) }));
  });

  it("commit rechecks a tightened definition budget after unrelated host registration", async () => {
    const host = setup({ limits: { maxDefinitions: 2 } });
    const child = value(host.createScope({ label: "limited", limits: { maxDefinitions: 1 } }));
    const local = endpoint("local-budget");
    const external = endpoint("external-budget");
    const gate = deferred<void>();
    const installing = host.install([{ name: "local", provides: { local }, async setup(ctx) {
      value(ctx.register(local, { run: () => Promise.resolve({ ok: true, value: "local" }) }));
      await gate.promise;
      return { ok: true, value: undefined };
    } }], { scope: child });
    await flush();
    value(host.register(external, { run: () => Promise.resolve({ ok: true, value: "external" }) }));
    gate.resolve();
    expect(await installing).toMatchObject({ ok: false, error: { code: "resource-limit" } });
    expect(child.use(local)).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    expect(host.inspect()).toMatchObject({ plugins: [], effects: 1, degraded: false });
  });

  it("cohort cleanup cannot extend the rollback deadline when cancellation callbacks advance time", async () => {
    let time = 0;
    const deadlines: number[] = [];
    const host = setup({ limits: { closeTimeoutMs: 10 }, scheduler: {
      now: () => time,
      delay(callback, ms) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    } });
    expect(await host.install([
      { name: "first", setup(ctx) {
        ctx.signal.addEventListener("abort", () => { time = 6; }, { once: true });
        return ctx.addCleanup((call) => { deadlines.push(call.deadline); return { ok: true, value: undefined }; });
      } },
      { name: "second", setup(ctx) {
        value(ctx.addCleanup((call) => { deadlines.push(call.deadline); return { ok: true, value: undefined }; }));
        return { ok: false, error: "rejected" };
      } },
    ])).toMatchObject({ ok: false, error: { code: "activation-failed" } });
    expect(deadlines).toEqual([10, 10]);
  });

  it("live root and child scopes do not retain revoked definition tokens in tombstones", async () => {
    const child = Bun.spawn(["bun", fileURLToPath(new URL("./collect-revoked-definitions.gc-case.ts", import.meta.url))], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_JSC_useJIT: "false" },
    });
    const deadline = setTimeout(() => { child.kill(); }, 1500);
    try {
      const [output, error, status] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(error).toBe("");
      expect(status).toBe(0);
      expect(output).toBe("revoked definitions collected\n");
    } finally {
      clearTimeout(deadline);
    }
  });

  it.each([null, false, 0, ""])("an explicit invalid scope %j cannot broaden installation to root", async (scope) => {
    const host = setup();
    const configuration = { scope } as unknown as Parameters<Host["install"]>[1];
    expect(await host.install([{ name: "isolated", setup() { return { ok: true, value: undefined }; } }], configuration))
      .toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(host.inspect()).toMatchObject({ plugins: [], effects: 0 });
  });
});

describe("scope tombstones only block unbound ancestor lookup", () => {
  it("an installed consumer keeps its bound dependency working after a child scope shadow is unloaded", async () => {
    const host = setup();
    const token = endpoint("tombstone-existing");
    const out = endpoint("tombstone-existing-out");
    value(await host.install([{ name: "base", provides: { token }, setup(ctx) {
      return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "base" }) });
    } }]));
    const child = value(host.createScope({ label: "child" }));
    value(await host.install([{ name: "existing-consumer", requires: { token }, provides: { out }, setup(ctx) {
      return ctx.service({ out: { run(input: undefined, invocation: import("../../index").Invocation) {
        return (invocation.deps.token as { run(source: undefined): Promise<Result<string>> }).run(undefined);
      } } }) as never;
    } }], { scope: child }));
    const shadow = value(await host.install([{ name: "shadow", provides: { token }, setup(ctx) {
      return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "shadow" }) }, { shadow: true });
    } }], { scope: child }));
    value(await host.uninstall(shadow.plugins[0]!));
    expect(value(await value(child.use(out)).run(undefined))).toBe("base");
  });

  it("a new required dependency anchors to a published ancestor provider despite a child scope tombstone", async () => {
    const host = setup();
    const token = endpoint("tombstone-fresh");
    value(await host.install([{ name: "base", provides: { token }, setup(ctx) {
      return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "base" }) });
    } }]));
    const child = value(host.createScope({ label: "child" }));
    const shadow = value(await host.install([{ name: "shadow", provides: { token }, setup(ctx) {
      return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "shadow" }) }, { shadow: true });
    } }], { scope: child }));
    value(await host.uninstall(shadow.plugins[0]!));
    expect(await host.install([{ name: "fresh-consumer", requires: { token }, setup() {
      return { ok: true, value: undefined };
    } }], { scope: child })).toMatchObject({ ok: true });
    const out = endpoint("tombstone-fresh-out");
    value(await host.install([{ name: "fresh-wiring", requires: { token }, provides: { out }, setup(ctx) {
      return ctx.service({ out: { run() { return Promise.resolve({ ok: true, value: "wired" }); } } });
    } }], { scope: child }));
    expect(value(await value(child.use(out)).run(undefined))).toBe("wired");
  });

  it("an unbound child lookup still refuses to fall back to an ancestor behind a tombstone", async () => {
    const host = setup();
    const token = endpoint("tombstone-unbound");
    value(await host.install([{ name: "base", provides: { token }, setup(ctx) {
      return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "base" }) });
    } }]));
    const child = value(host.createScope({ label: "child" }));
    const shadow = value(await host.install([{ name: "shadow", provides: { token }, setup(ctx) {
      return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "shadow" }) }, { shadow: true });
    } }], { scope: child }));
    value(await host.uninstall(shadow.plugins[0]!));
    expect(child.use(token)).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    expect(host.use(token)).toMatchObject({ ok: true });
  });

  it("reinstalling the same token in the root after a full unload publishes a working provider", async () => {
    const host = setup();
    const token = endpoint("tombstone-root-reinstall");
    const base = value(await host.install([{ name: "base", provides: { token }, setup(ctx) {
      return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "base" }) });
    } }]));
    value(await host.uninstall(base.plugins[0]!));
    expect(host.use(token)).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    value(await host.install([{ name: "replacement", provides: { token }, setup(ctx) {
      return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "replacement" }) });
    } }]));
    expect(value(await value(host.use(token)).run(undefined))).toBe("replacement");
  });
});

describe("activation failure attribution", () => {
  it("a setup business failure reports the owning plugin with its cause preserved", async () => {
    const host = setup();
    const token = endpoint("attribution-business");
    expect(await host.install([{ name: "fail-setup", provides: { token }, setup() {
      return { ok: false, error: { business: "rejected" } };
    } }])).toMatchObject({ ok: false, error: { code: "activation-failed", pluginName: "fail-setup", details: { cause: { business: "rejected" } } } });
    expect(host.inspect()).toMatchObject({ degraded: false });
  });

  it("a setup throw reports the owning plugin as a callback failure", async () => {
    const host = setup();
    const token = endpoint("attribution-throw");
    expect(await host.install([{ name: "throw-setup", provides: { token }, setup() {
      throw new Error("secret");
    } }])).toMatchObject({ ok: false, error: { code: "callback-failed", pluginName: "throw-setup" } });
    expect(JSON.stringify(host.diagnostics())).not.toContain("secret");
  });

  it("a missing declared provider reports the owning plugin without a cause payload", async () => {
    const host = setup();
    const token = endpoint("attribution-incomplete");
    expect(await host.install([{ name: "incomplete", provides: { token }, setup() {
      return { ok: true, value: undefined };
    } }])).toMatchObject({ ok: false, error: { code: "activation-failed", pluginName: "incomplete" } });
    expect(host.inspect()).toMatchObject({ plugins: [] });
  });
});

describe("service lease budget independence", () => {
  it("three dependencies across 350 concurrent calls acquire without lease exhaustion", async () => {
    const host = setup();
    const one = endpoint("lease-one");
    const two = endpoint("lease-two");
    const three = endpoint("lease-three");
    const out = endpoint("lease-out");
    for (const [token, name] of [[one, "one"], [two, "two"], [three, "three"]] as const) {
      value(host.register(token, { run: () => Promise.resolve({ ok: true, value: name }) }));
    }
    value(await host.install([{ name: "fanout", requires: { one, two, three }, provides: { out }, setup(ctx) {
      return ctx.service({ out: { run(input: undefined, invocation: import("../../index").Invocation) {
        const deps = invocation.deps as Record<string, { run(source: undefined): Promise<Result<string>> }>;
        const sources = [deps.one, deps.two, deps.three].map((entry) => entry!.run(undefined));
        return Promise.all(sources).then((results) => results.every((result) => result.ok)
          ? { ok: true as const, value: results.map((result) => result.ok ? result.value : "").join(",") }
          : { ok: false as const, error: results.find((result) => !result.ok)!.error });
      } } }) as never;
    } }]));
    const bound = value(host.use(out));
    const pending = Array.from({ length: 350 }, () => bound.run(undefined));
    const outcomes = await Promise.all(pending);
    const failed = outcomes.filter((result) => !result.ok || result.value !== "one,two,three");
    expect(failed).toEqual([]);
    expect(host.inspect()).toMatchObject({ activeCalls: 0, activeTasks: 0 });
  });

  it("the per-owner durable lease limit is independent from registration capacity", async () => {
    const host = setup({ limits: { maxServiceLeasesPerOwner: 1 } });
    const first = endpoint("owner-limit-first");
    const second = endpoint("owner-limit-second");
    const holder = value(host.createScope({ label: "holder" }));
    value(host.register(first, { run: () => Promise.resolve({ ok: true, value: "first" }) }));
    value(host.register(second, { run: () => Promise.resolve({ ok: true, value: "second" }) }));
    value(holder.use(first));
    expect(holder.use(second)).toMatchObject({ ok: false, error: { code: "resource-limit" } });
    expect(host.register(endpoint("owner-limit-extra"), { run: () => Promise.resolve({ ok: true, value: "extra" }) })).toMatchObject({ ok: true });
    value(await host.closeScope(holder));
    expect(host.use(first)).toMatchObject({ ok: true });
  });
});
