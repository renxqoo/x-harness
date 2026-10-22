import { afterEach, expect, it } from "vitest";
import { defineService } from "../../index";
import type { Context, CoreFault, Host, Result } from "../../index";
import { root, value } from "../../__test__/helpers";

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

it("missing dependency names the plugin and definition before setup executes", async () => {
  const host = create();
  const token = service("database");
  let called = false;
  const error = failure(
    await host.install([
      {
        name: "users",
        requires: { database: token },
        setup() {
          called = true;
          return ok();
        },
      },
    ]),
  );
  expect(error).toMatchObject({
    code: "missing-dependency",
    scopeId: "root",
    pluginName: "users",
    details: { definition: "service/database" },
  });
  recorded(host, error);
  expect(called).toBe(false);
  expect(host.inspect().plugins).toEqual([]);
});

it("dependency snapshots distinguish fixed providers and absent optional declarations across scopes", async () => {
  const host = create();
  const token = service("database");
  const optional = service("cache");
  value(
    await host.install([
      { name: "storage", provides: { token }, setup: (ctx) => ctx.register(token, implementation) },
    ]),
  );
  const child = value(host.createScope({ label: "child" }));
  value(
    await host.install(
      [{ name: "users", requires: { database: token }, optional: { cache: optional }, setup: ok }],
      { scope: child },
    ),
  );
  const sibling = value(host.createScope({ label: "sibling" }));
  value(
    await host.install(
      [
        {
          name: "storage",
          provides: { token },
          setup: (ctx) => ctx.register(token, implementation, { shadow: true }),
        },
      ],
      { scope: sibling },
    ),
  );
  const snapshot = host.inspect();
  const consumer = snapshot.plugins.find((plugin) => plugin.ref.name === "users")!;
  expect(consumer.dependencies).toEqual([
    {
      name: "database",
      definition: { kind: "service", name: "database" },
      optional: false,
      provider: snapshot.plugins[0]!.provides[0],
    },
    {
      name: "cache",
      definition: { kind: "service", name: "cache" },
      optional: true,
      provider: null,
    },
  ]);
  expect(consumer.dependencies[0]!.provider!.owner.scopeId).toBe("root");
  expect(snapshot.plugins[0]!.ref.instanceId).not.toBe(snapshot.plugins[2]!.ref.instanceId);
  expect(consumer.dependencies[0]!.definition).not.toBe(token);
  expect(Object.isFrozen(consumer.dependencies[0]!.provider!.owner)).toBe(true);
  expect(Object.isFrozen(consumer.dependencies)).toBe(true);
  expect(Object.isFrozen(snapshot.plugins)).toBe(true);
});

it("uninstall and self-close identify the consumer without stopping the provider", async () => {
  const host = create();
  const token = service("storage");
  let context!: Context;
  const installed = value(
    await host.install([
      {
        name: "storage",
        provides: { token },
        setup(ctx) {
          context = ctx;
          return ctx.register(token, implementation);
        },
      },
      { name: "users", requires: { token }, setup: ok },
    ]),
  );

  for (const result of [await host.uninstall(installed.plugins[0]!), context.requestClose()]) {
    const error = failure(result);
    expect(error).toMatchObject({
      code: "plugin-in-use",
      pluginName: "storage",
      details: {
        provider: {
          definition: { kind: "service", name: "storage" },
          owner: { pluginName: "storage" },
        },
        consumers: { total: 1, omitted: 0, items: [{ pluginName: "users" }] },
      },
    });
    recorded(host, error);
  }

  expect(context.signal.aborted).toBe(false);
  expect(value(await value(host.use(token)).run("live"))).toBe("live");
});

it("failed cleanup pins retain resource ownership without leaking connection values", async () => {
  const host = create();
  const token = service("storage");
  const installed = value(
    await host.install([
      { name: "storage", provides: { token }, setup: (ctx) => ctx.register(token, implementation) },
    ]),
  );
  const child = value(host.createScope({ label: "child" }));
  value(
    await host.install(
      [
        {
          name: "consumer",
          requires: { token },
          setup(ctx) {
            return ctx.resource({
              open: () => ({ ok: true, value: "secret connection" }),
              close: () => ({
                ok: false,
                error: { source: "core", code: "cleanup-failed", message: "private exception" },
              }),
            });
          },
        },
      ],
      { scope: child },
    ),
  );
  failure(await host.closeScope(child));
  const error = failure(await host.uninstall(installed.plugins[0]!, { cascade: true }));
  expect(["close-incomplete", "plugin-in-use"]).toContain(error.code);
  recorded(host, error);
  expect(
    host
      .inspect()
      .resources.some(
        (resource) => resource.state === "failed" && resource.owner.pluginName === "consumer",
      ),
  ).toBe(true);
  expect(
    JSON.stringify({ inspection: host.inspect(), diagnostics: host.diagnostics() }),
  ).not.toMatch(/secret connection|private exception/);
});

it("provider disposer identifies its cleanup pins and remains usable after refusal", async () => {
  const host = create();
  const token = service("storage");
  const dispose = value(host.register(token, implementation));
  const cleanup = value(host.addCleanup(ok));
  const error = failure(await dispose());
  expect(error).toMatchObject({
    code: "plugin-in-use",
    details: { resources: { total: 1, items: [{ kind: "cleanup", owner: { id: "host" } }] } },
  });
  recorded(host, error);
  value(await cleanup());
  value(await dispose());
  expect(host.inspect().resources).toEqual([]);
});

it.each([false, true])(
  "host-owned pins identify their scope when cascade is %s",
  async (cascade) => {
    const host = create();
    const token = service("connection");
    const installed = value(
      await host.install([
        {
          name: "storage",
          provides: { token },
          setup(ctx) {
            return ctx.register(token, {
              run(input, call) {
                const effect = call.effect(ok);
                return Promise.resolve(effect.ok ? { ok: true, value: input } : effect);
              },
            });
          },
        },
      ]),
    );
    const child = value(host.createScope({ label: "request" }));
    value(await value(child.use(token)).run("input"));
    const resource = host.inspect().resources.find((item) => item.owner.scopeId === child.scopeId)!;
    expect(resource).toMatchObject({
      kind: "cleanup",
      owner: { kind: "host", scopeId: child.scopeId },
      executor: { pluginName: "storage" },
    });
    const error = failure(await host.uninstall(installed.plugins[0]!, { cascade }));
    expect(error).toMatchObject({
      code: "plugin-in-use",
      details: {
        resources: { total: 1, items: [{ id: resource.id, owner: { scopeId: child.scopeId } }] },
      },
    });
    recorded(host, error);
    expect(host.inspect().plugins[0]!.state).toBe("active");
    value(await host.closeScope(child));
    value(await host.uninstall(installed.plugins[0]!));
  },
);
