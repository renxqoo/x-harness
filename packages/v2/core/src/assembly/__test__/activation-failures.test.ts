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

describe("activation failure attribution", () => {
  it("a setup business failure reports the owning plugin with its cause preserved", async () => {
    const host = setup();
    const token = endpoint("attribution-business");
    expect(
      await host.install([
        {
          name: "fail-setup",
          provides: { token },
          setup() {
            return { ok: false, error: { business: "rejected" } };
          },
        },
      ]),
    ).toMatchObject({
      ok: false,
      error: {
        code: "activation-failed",
        pluginName: "fail-setup",
        details: { cause: { business: "rejected" } },
      },
    });
    expect(host.inspect()).toMatchObject({ degraded: false });
  });

  it("a setup throw reports the owning plugin as a callback failure", async () => {
    const host = setup();
    const token = endpoint("attribution-throw");
    expect(
      await host.install([
        {
          name: "throw-setup",
          provides: { token },
          setup() {
            throw new Error("secret");
          },
        },
      ]),
    ).toMatchObject({ ok: false, error: { code: "callback-failed", pluginName: "throw-setup" } });
    expect(JSON.stringify(host.diagnostics())).not.toContain("secret");
  });

  it("a missing declared provider reports the owning plugin without a cause payload", async () => {
    const host = setup();
    const token = endpoint("attribution-incomplete");
    expect(
      await host.install([
        {
          name: "incomplete",
          provides: { token },
          setup() {
            return { ok: true, value: undefined };
          },
        },
      ]),
    ).toMatchObject({ ok: false, error: { code: "activation-failed", pluginName: "incomplete" } });
    expect(host.inspect()).toMatchObject({ plugins: [] });
  });
});

describe("hostile activation failures", () => {
  it("a hostile error payload still rolls the batch back and releases reservations", async () => {
    const host = setup();
    const token = endpoint("hostile-payload");
    const evil = new Proxy(
      {},
      {
        has() {
          throw new Error("boom-has");
        },
        getOwnPropertyDescriptor() {
          return undefined;
        },
        getPrototypeOf() {
          return Object.prototype;
        },
      },
    );
    expect(
      await host.install([
        {
          name: "evil",
          provides: { token },
          setup() {
            return { ok: false, error: evil };
          },
        },
      ]),
    ).toMatchObject({ ok: false, error: { code: "activation-failed", pluginName: "evil" } });
    expect(host.inspect()).toMatchObject({ plugins: [], degraded: false });
    expect(
      host.register(token, { run: () => Promise.resolve({ ok: true, value: "after" }) }),
    ).toMatchObject({ ok: true });
  });

  it("a hostile Error subclass getter still rolls the batch back", async () => {
    const host = setup();
    const token = endpoint("hostile-getter");
    const hostile = new Error("m");
    Object.defineProperty(hostile, "name", {
      get() {
        throw new Error("boom-name");
      },
    });
    expect(
      await host.install([
        {
          name: "evil-getter",
          provides: { token },
          setup() {
            return { ok: false, error: hostile };
          },
        },
      ]),
    ).toMatchObject({ ok: false, error: { code: "activation-failed", pluginName: "evil-getter" } });
    expect(host.inspect()).toMatchObject({ plugins: [], degraded: false });
    expect(
      host.register(token, { run: () => Promise.resolve({ ok: true, value: "after" }) }),
    ).toMatchObject({ ok: true });
  });

  it("an Error instance is preserved as a normalized cause payload", async () => {
    const host = setup();
    const token = endpoint("error-cause");
    expect(
      await host.install([
        {
          name: "error-biz",
          provides: { token },
          setup() {
            return { ok: false, error: new Error("boom-message") };
          },
        },
      ]),
    ).toMatchObject({
      ok: false,
      error: {
        code: "activation-failed",
        pluginName: "error-biz",
        details: { cause: { name: "Error", message: "boom-message" } },
      },
    });
  });
});
