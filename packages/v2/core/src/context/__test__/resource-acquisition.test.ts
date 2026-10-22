import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, defineService } from "../../index";
import type { Result, Host } from "../../index";
import { clock, deferred, flush, root, value } from "../../__test__/helpers";

const roots: Host[] = [];
afterEach(async () => {
  for (const host of roots.splice(0)) await host.close();
});

const host = (options?: Parameters<typeof root>[0]) => {
  const created = root(options);
  roots.push(created);
  return created;
};

const endpoint = (name: string) =>
  value(
    defineService<{ run(input: string): Promise<Result<string>> }>({ name, methods: { run: {} } }),
  );

describe("paired resource acquisition", () => {
  it("resources are acquired once and released after their actual users finish", async () => {
    const app = host();
    const target = endpoint("authoring/resource");
    const gate = deferred<Result<string>>();
    let released = 0;
    const installed = value(
      await app.install([
        definePlugin({
          name: "provider",
          provides: { target },
          async setup(ctx) {
            const acquired = await ctx.resource({
              open: () => ({ ok: true, value: "connection" }),
              close: () => {
                released += 1;
                return { ok: true, value: undefined };
              },
            });

            if (!acquired.ok) return acquired;

            return ctx.service({
              target: {
                async run() {
                  return gate.promise;
                },
              },
            });
          },
        }),
      ]),
    );
    const running = value(app.use(target)).run("input");
    await flush();
    const closing = app.uninstall(installed.plugins[0]!);
    await flush();
    expect(released).toBe(0);
    gate.resolve({ ok: true, value: "done" });
    await running;
    value(await closing);
    expect(released).toBe(1);
  });

  it("a timed out acquisition is reclaimed after late success while its owner stays active", async () => {
    const time = clock();
    const app = host({ scheduler: time.scheduler, limits: { callTimeoutMs: 10 } });
    const gate = deferred<Result<number>>();
    let released = 0;
    const acquiring = app.resource({
      open: () => gate.promise,
      close: () => {
        released += 1;
        return { ok: true, value: undefined };
      },
    });
    await flush();
    time.advance(10);
    expect(await acquiring).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(app.inspect()).toMatchObject({ state: "open", activeCalls: 1, effects: 1 });
    gate.resolve({ ok: true, value: 7 });
    await flush();
    expect(released).toBe(1);
    expect(app.inspect()).toMatchObject({ state: "open", activeCalls: 0, effects: 0 });
  });

  it("acquisition failures remove their empty records without invoking release", async () => {
    const app = host();
    let released = false;
    expect(
      await app.resource({
        open: () => ({ ok: false, error: "offline" }),
        close: () => {
          released = true;
          return { ok: true, value: undefined };
        },
      }),
    ).toEqual({ ok: false, error: "offline" });
    await flush();
    expect(released).toBe(false);
    expect(app.inspect().effects).toBe(0);
  });

  it("resource budgets are reserved before external allocation", async () => {
    const app = host({ limits: { maxEffects: 1 } });
    value(app.addCleanup(() => ({ ok: true, value: undefined })));
    let acquired = false;
    expect(
      (
        await app.resource({
          open: () => {
            acquired = true;
            return { ok: true, value: 1 };
          },
          close: () => ({ ok: true, value: undefined }),
        })
      ).ok,
    ).toBe(false);
    expect(acquired).toBe(false);
  });

  it("acquire dependencies are parented to acquisition and not the setup caller", async () => {
    const app = host();
    const source = endpoint("authoring/acquire-dependency");
    let acquireId: string | undefined;
    let parentId: string | undefined;
    value(
      app.register(source, {
        async run(input, call) {
          parentId = call.parentId;
          return { ok: true, value: input };
        },
      }),
    );
    value(
      await app.install([
        definePlugin({
          name: "consumer",
          requires: { source },
          async setup(ctx) {
            return ctx.resource({
              open(call) {
                acquireId = call.id;
                return call.deps.source.run("acquire");
              },
              close: () => ({ ok: true, value: undefined }),
            });
          },
        }),
      ]),
    );
    expect(parentId).toBe(acquireId);
  });

  it("request resources belong to the consumer and retain their cleanup dependency", async () => {
    const app = host();
    const target = endpoint("authoring/consumer-resource");
    let released = 0;
    const installed = value(
      await app.install([
        definePlugin({
          name: "provider",
          provides: { target },
          setup(ctx) {
            return ctx.service({
              target: {
                async run(input, call) {
                  const resource = await call.resource({
                    open: () => ({ ok: true, value: input }),
                    close: () => {
                      released += 1;
                      return { ok: true, value: undefined };
                    },
                  });
                  return resource;
                },
              },
            });
          },
        }),
      ]),
    );
    const consumer = value(app.createScope({ label: "consumer" }));
    expect(value(await value(consumer.use(target)).run("resource"))).toBe("resource");
    expect((await app.uninstall(installed.plugins[0]!)).ok).toBe(false);
    value(await app.closeScope(consumer));
    expect(released).toBe(1);
    value(await app.uninstall(installed.plugins[0]!));
  });

  it("cleanup failure retains the resource record and does not report a clean close", async () => {
    const app = host();
    value(
      await app.resource({
        open: () => ({ ok: true, value: 1 }),
        close: () => ({
          ok: false,
          error: { source: "core", code: "cleanup-failed", message: "failed" },
        }),
      }),
    );
    expect((await app.close()).ok).toBe(false);
    expect(app.inspect()).toMatchObject({ state: "close-failed", effects: 1 });
  });

  it("invalid resource specifications and revoked calls never invoke allocation", async () => {
    const app = host();

    for (const spec of [null, {}, { open: 1, close: 1 }, { open() {}, close() {}, extra: true }]) {
      expect((await app.resource(spec as never)).ok).toBe(false);
    }

    value(await app.close());
    expect(
      (
        await app.resource({
          open: () => ({ ok: true, value: 1 }),
          close: () => ({ ok: true, value: undefined }),
        })
      ).ok,
    ).toBe(false);
  });
});
