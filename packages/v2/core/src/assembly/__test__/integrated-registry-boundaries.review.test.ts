import { afterEach, describe, expect, it } from "vitest";
import { createHost, defineService } from "../../index";
import type { Context, Result, Host } from "../../index";

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

function setup() {
  const host = value(createHost({ limits: { callTimeoutMs: 100, closeTimeoutMs: 100 } }));
  roots.push(host);
  return host;
}

function endpoint(name: string) {
  return value(
    defineService<{ run(input: void): Promise<Result<string>> }>({ name, methods: { run: {} } }),
  );
}

afterEach(async () => {
  for (const host of roots.splice(0)) await host.close();
});

describe("integrated registration boundaries", () => {
  it("manual provider release cannot admit a same-tick call that outlives successful revocation", async () => {
    const host = setup();
    const token = endpoint("revocation-admission");
    const gate = deferred<Result<string>>();
    let starts = 0;
    const off = value(
      host.register(token, {
        run() {
          starts += 1;
          return gate.promise;
        },
      }),
    );
    const retained = value(host.use(token));
    const releasing = off();
    const invoking = retained.run(undefined);
    const receipt = await releasing;
    await flush();
    const activeCalls = host.inspect().activeCalls;
    const startedBeforeReleaseSettled = starts;
    gate.resolve({ ok: true, value: "late" });
    const invocation = await invoking;
    expect({ receipt, activeCalls, startedBeforeReleaseSettled, invocation }).toMatchObject({
      receipt: { ok: true },
      activeCalls: 0,
      startedBeforeReleaseSettled: 0,
      invocation: { ok: false, error: { code: "service-unavailable" } },
    });
  });

  it("owned delegated scope bindings disappear with the installing owner and release definition identity", async () => {
    const host = setup();
    const token = endpoint("delegated-identity");
    let child!: Context;
    const installed = value(
      await host.install([
        {
          name: "creator",
          provides: { token },
          setup(ctx) {
            child = value(ctx.createScope({ label: "delegated" }));
            return ctx.register(token, {
              run: () => Promise.resolve({ ok: true, value: "owned" }),
            });
          },
        },
      ]),
    );
    expect(value(await value(child.use(token)).run(undefined))).toBe("owned");
    value(await host.uninstall(installed.plugins[0]!));
    expect(child.scopeState).toBe("closed");
    const replacement = endpoint("delegated-identity");
    value(
      host.register(replacement, {
        run: () => Promise.resolve({ ok: true, value: "replacement" }),
      }),
    );
    expect(value(await value(host.use(replacement)).run(undefined))).toBe("replacement");
  });

  it("failed consumer cleanup keeps provider pins and prevents default or cascade unload", async () => {
    const host = setup();
    const token = endpoint("failed-cleanup-pin");
    const installed = value(
      await host.install([
        {
          name: "provider",
          provides: { token },
          setup(ctx) {
            return ctx.register(token, {
              run(_input, call) {
                const resource = call.effect(() => ({
                  ok: false,
                  error: { source: "core", code: "cleanup-failed", message: "cleanup failed" },
                }));

                if (!resource.ok) return Promise.resolve(resource);

                return Promise.resolve({ ok: true, value: "resource" });
              },
            });
          },
        },
      ]),
    );
    const child = value(host.createScope({ label: "consumer" }));
    value(await value(child.use(token)).run(undefined));
    expect(await host.closeScope(child)).toMatchObject({
      ok: false,
      error: { code: "close-incomplete" },
    });
    expect(await host.uninstall(installed.plugins[0]!)).toMatchObject({
      ok: false,
      error: { code: "plugin-in-use" },
    });
    expect(await host.uninstall(installed.plugins[0]!, { cascade: true })).toMatchObject({
      ok: false,
      error: { code: "plugin-in-use" },
    });
    expect(host.inspect()).toMatchObject({ effects: 2, plugins: [{ state: "active" }] });
  });
});
