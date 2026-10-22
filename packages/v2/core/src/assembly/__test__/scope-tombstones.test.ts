import { afterEach, describe, expect, it } from "vitest";
import { createHost, defineService } from "../../index";
import type { HostOptions, Result, Host } from "../../index";

type Endpoint = { run(input: void): Promise<Result<string>> };

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
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

describe("scope tombstones only block unbound ancestor lookup", () => {
  it("an installed consumer keeps its bound dependency working after a child scope shadow is unloaded", async () => {
    const host = setup();
    const token = endpoint("tombstone-existing");
    const out = endpoint("tombstone-existing-out");
    value(
      await host.install([
        {
          name: "base",
          provides: { token },
          setup(ctx) {
            return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "base" }) });
          },
        },
      ]),
    );
    const child = value(host.createScope({ label: "child" }));
    value(
      await host.install(
        [
          {
            name: "existing-consumer",
            requires: { token },
            provides: { out },
            setup(ctx) {
              return ctx.service({
                out: {
                  run(input: undefined, invocation: import("../../index").Invocation) {
                    return (
                      invocation.deps.token as { run(source: undefined): Promise<Result<string>> }
                    ).run(undefined);
                  },
                },
              }) as never;
            },
          },
        ],
        { scope: child },
      ),
    );
    const shadow = value(
      await host.install(
        [
          {
            name: "shadow",
            provides: { token },
            setup(ctx) {
              return ctx.register(
                token,
                { run: () => Promise.resolve({ ok: true, value: "shadow" }) },
                { shadow: true },
              );
            },
          },
        ],
        { scope: child },
      ),
    );
    value(await host.uninstall(shadow.plugins[0]!));
    expect(value(await value(child.use(out)).run(undefined))).toBe("base");
  });

  it("a new required dependency anchors to a published ancestor provider despite a child scope tombstone", async () => {
    const host = setup();
    const token = endpoint("tombstone-fresh");
    value(
      await host.install([
        {
          name: "base",
          provides: { token },
          setup(ctx) {
            return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "base" }) });
          },
        },
      ]),
    );
    const child = value(host.createScope({ label: "child" }));
    const shadow = value(
      await host.install(
        [
          {
            name: "shadow",
            provides: { token },
            setup(ctx) {
              return ctx.register(
                token,
                { run: () => Promise.resolve({ ok: true, value: "shadow" }) },
                { shadow: true },
              );
            },
          },
        ],
        { scope: child },
      ),
    );
    value(await host.uninstall(shadow.plugins[0]!));
    expect(
      await host.install(
        [
          {
            name: "fresh-consumer",
            requires: { token },
            setup() {
              return { ok: true, value: undefined };
            },
          },
        ],
        { scope: child },
      ),
    ).toMatchObject({ ok: true });
    const out = endpoint("tombstone-fresh-out");
    value(
      await host.install(
        [
          {
            name: "fresh-wiring",
            requires: { token },
            provides: { out },
            setup(ctx) {
              return ctx.service({
                out: {
                  run() {
                    return Promise.resolve({ ok: true, value: "wired" });
                  },
                },
              });
            },
          },
        ],
        { scope: child },
      ),
    );
    expect(value(await value(child.use(out)).run(undefined))).toBe("wired");
  });

  it("an unbound child lookup still refuses to fall back to an ancestor behind a tombstone", async () => {
    const host = setup();
    const token = endpoint("tombstone-unbound");
    value(
      await host.install([
        {
          name: "base",
          provides: { token },
          setup(ctx) {
            return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "base" }) });
          },
        },
      ]),
    );
    const child = value(host.createScope({ label: "child" }));
    const shadow = value(
      await host.install(
        [
          {
            name: "shadow",
            provides: { token },
            setup(ctx) {
              return ctx.register(
                token,
                { run: () => Promise.resolve({ ok: true, value: "shadow" }) },
                { shadow: true },
              );
            },
          },
        ],
        { scope: child },
      ),
    );
    value(await host.uninstall(shadow.plugins[0]!));
    expect(child.use(token)).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    expect(host.use(token)).toMatchObject({ ok: true });
  });

  it("reinstalling the same token in the root after a full unload publishes a working provider", async () => {
    const host = setup();
    const token = endpoint("tombstone-root-reinstall");
    const base = value(
      await host.install([
        {
          name: "base",
          provides: { token },
          setup(ctx) {
            return ctx.register(token, { run: () => Promise.resolve({ ok: true, value: "base" }) });
          },
        },
      ]),
    );
    value(await host.uninstall(base.plugins[0]!));
    expect(host.use(token)).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    value(
      await host.install([
        {
          name: "replacement",
          provides: { token },
          setup(ctx) {
            return ctx.register(token, {
              run: () => Promise.resolve({ ok: true, value: "replacement" }),
            });
          },
        },
      ]),
    );
    expect(value(await value(host.use(token)).run(undefined))).toBe("replacement");
  });
});
