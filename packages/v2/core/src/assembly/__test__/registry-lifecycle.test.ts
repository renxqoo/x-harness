import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createHost, defineService } from "../../index";
import type { Context, HostOptions, Result, Host } from "../../index";

type Endpoint = { run(input: void): Promise<Result<string>> };

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush() {
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
}

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
    const installing = host.install([
      {
        name: "provider",
        provides: { token },
        async setup(ctx) {
          await gate.promise;
          return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "plugin" }) });
        },
      },
    ]);
    await flush();
    expect(host.use(token)).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    expect(
      host.register(token, { run: () => Promise.resolve({ ok: true, value: "host" }) }),
    ).toMatchObject({ ok: false, error: { code: "duplicate-provider" } });
    gate.resolve();
    value(await installing);
    expect(value(await value(host.use(token)).run(undefined))).toBe("plugin");
  });

  it("a failed unconfigured reservation releases both its slot and definition identity", async () => {
    const host = setup({ limits: { maxDefinitions: 1 } });
    const original = endpoint("released");
    expect(
      await host.install([
        {
          name: "provider",
          provides: { original },
          setup() {
            return { ok: false, error: "rejected" };
          },
        },
      ]),
    ).toMatchObject({ ok: false, error: { code: "activation-failed" } });
    const replacement = endpoint("released");
    value(
      host.register(replacement, {
        run: () => Promise.resolve({ ok: true, value: "replacement" }),
      }),
    );
    expect(host.inspect()).toMatchObject({ plugins: [], effects: 1, degraded: false });
  });

  it("missing optional references reserve capacity until their owner unloads", async () => {
    const host = setup({ limits: { maxDefinitions: 1 } });
    const referenced = endpoint("referenced");
    const other = endpoint("other");
    const installed = value(
      await host.install([
        {
          name: "consumer",
          optional: { referenced },
          setup() {
            return { ok: true, value: undefined };
          },
        },
      ]),
    );
    expect(
      host.register(other, { run: () => Promise.resolve({ ok: true, value: "other" }) }),
    ).toMatchObject({ ok: false, error: { code: "resource-limit" } });
    value(await host.uninstall(installed.plugins[0]!));
    value(host.register(other, { run: () => Promise.resolve({ ok: true, value: "other" }) }));
  });

  it("self-requested plugin closure releases definitions even when it provides no capability", async () => {
    const host = setup({ limits: { maxDefinitions: 1 } });
    const original = endpoint("closed-owner");
    let context!: Context;
    value(
      await host.install([
        {
          name: "consumer",
          optional: { original },
          setup(ctx) {
            context = ctx;
            return { ok: true, value: undefined };
          },
        },
      ]),
    );
    value(context.requestClose());
    await flush();
    const replacement = endpoint("closed-owner");
    value(
      host.register(replacement, {
        run: () => Promise.resolve({ ok: true, value: "replacement" }),
      }),
    );
  });

  it("provider release cannot remove a definition still referenced by an absent optional binding", async () => {
    const host = setup();
    const original = endpoint("retained");
    let consumer!: Context;
    const installed = value(
      await host.install([
        {
          name: "consumer",
          optional: { original },
          setup(ctx) {
            consumer = ctx;
            return { ok: true, value: undefined };
          },
        },
      ]),
    );
    const off = value(
      host.register(original, { run: () => Promise.resolve({ ok: true, value: "original" }) }),
    );
    expect(consumer.use(original)).toMatchObject({
      ok: false,
      error: { code: "service-unavailable" },
    });
    value(await off());
    const replacement = endpoint("retained");
    expect(
      host.register(replacement, {
        run: () => Promise.resolve({ ok: true, value: "replacement" }),
      }),
    ).toMatchObject({ ok: false, error: { code: "definition-conflict" } });
    value(await host.uninstall(installed.plugins[0]!));
    value(
      host.register(replacement, {
        run: () => Promise.resolve({ ok: true, value: "replacement" }),
      }),
    );
  });

  it("conflicting optional identities in one batch reject before activation or reservation", async () => {
    const host = setup({ limits: { maxDefinitions: 1 } });
    const a = endpoint("same-name");
    const b = endpoint("same-name");
    let activated = false;
    expect(
      await host.install([
        {
          name: "consumer",
          optional: { a, b },
          setup() {
            activated = true;
            return { ok: true, value: undefined };
          },
        },
      ]),
    ).toMatchObject({ ok: false, error: { code: "definition-conflict" } });
    expect(activated).toBe(false);
    value(host.register(a, { run: () => Promise.resolve({ ok: true, value: "available" }) }));
  });

  it("parent provider appearing during activation cannot silently introduce implicit shadowing", async () => {
    const host = setup();
    const child = value(host.createScope({ label: "child" }));
    const token = endpoint("ancestor-race");
    const gate = deferred<void>();
    const installing = host.install(
      [
        {
          name: "local",
          provides: { token },
          async setup(ctx) {
            value(
              ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "child" }) }),
            );
            await gate.promise;
            return { ok: true, value: undefined };
          },
        },
      ],
      { scope: child },
    );
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
    const installing = host.install(
      [
        {
          name: "local",
          provides: { token },
          async setup(ctx) {
            value(
              ctx.register(
                token,
                { run: () => Promise.resolve({ ok: true, value: "child" }) },
                { shadow: true },
              ),
            );
            await gate.promise;
            return { ok: true, value: undefined };
          },
        },
      ],
      { scope: child },
    );
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
    const loaded = value(
      await host.install([
        {
          name: "releasing",
          setup(ctx) {
            return ctx.addCleanup(async () => {
              cleaning = true;
              await gate.promise;
              return { ok: true, value: undefined };
            });
          },
        },
      ]),
    );
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
    const installing = host.install([
      {
        name: "provider",
        provides: { token },
        async setup(ctx) {
          const provided = ctx.register(token, {
            run: () => Promise.resolve({ ok: true, value: "plugin" }),
          });
          refusal = provided;
          await gate.promise;
          return provided;
        },
      },
    ]);
    await flush();
    value(await occupied());
    const competing = host.register(token, {
      run: () => Promise.resolve({ ok: true, value: "host" }),
    });
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
    const installing = host.install(
      [
        {
          name: "local",
          provides: { local },
          async setup(ctx) {
            value(
              ctx.register(local, { run: () => Promise.resolve({ ok: true, value: "local" }) }),
            );
            await gate.promise;
            return { ok: true, value: undefined };
          },
        },
      ],
      { scope: child },
    );
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
    const host = setup({
      limits: { closeTimeoutMs: 10 },
      scheduler: {
        now: () => time,
        delay(callback, ms) {
          const timer = setTimeout(callback, ms);
          return () => clearTimeout(timer);
        },
      },
    });
    expect(
      await host.install([
        {
          name: "first",
          setup(ctx) {
            ctx.signal.addEventListener(
              "abort",
              () => {
                time = 6;
              },
              { once: true },
            );
            return ctx.addCleanup((call) => {
              deadlines.push(call.deadline);
              return { ok: true, value: undefined };
            });
          },
        },
        {
          name: "second",
          setup(ctx) {
            value(
              ctx.addCleanup((call) => {
                deadlines.push(call.deadline);
                return { ok: true, value: undefined };
              }),
            );
            return { ok: false, error: "rejected" };
          },
        },
      ]),
    ).toMatchObject({ ok: false, error: { code: "activation-failed" } });
    expect(deadlines).toEqual([10, 10]);
  });

  it("live root and child scopes do not retain revoked definition tokens in tombstones", async () => {
    const child = Bun.spawn(
      ["bun", fileURLToPath(new URL("./collect-revoked-definitions.gc-case.ts", import.meta.url))],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, BUN_JSC_useJIT: "false" },
      },
    );
    const deadline = setTimeout(() => {
      child.kill();
    }, 1500);

    try {
      const [output, error, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(error).toBe("");
      expect(status).toBe(0);
      expect(output).toBe("revoked definitions collected\n");
    } finally {
      clearTimeout(deadline);
    }
  });

  it("definitions registered inside a rolled back batch are collectable after close", async () => {
    const child = Bun.spawn(
      ["bun", fileURLToPath(new URL("./collect-rollback-definitions.gc-case.ts", import.meta.url))],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, BUN_JSC_useJIT: "false" },
      },
    );
    const deadline = setTimeout(() => {
      child.kill();
    }, 1500);

    try {
      const [output, error, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(error).toBe("");
      expect(status).toBe(0);
      expect(output).toBe("definitions collected\n");
    } finally {
      clearTimeout(deadline);
    }
  });

  it.each([null, false, 0, ""])(
    "an explicit invalid scope %j cannot broaden installation to root",
    async (scope) => {
      const host = setup();
      const configuration = { scope } as unknown as Parameters<Host["install"]>[1];
      expect(
        await host.install(
          [
            {
              name: "isolated",
              setup() {
                return { ok: true, value: undefined };
              },
            },
          ],
          configuration,
        ),
      ).toMatchObject({ ok: false, error: { code: "invalid-input" } });
      expect(host.inspect()).toMatchObject({ plugins: [], effects: 0 });
    },
  );
});
