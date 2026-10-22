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

describe("service lease budget independence", () => {
  it("three dependencies across 350 concurrent calls acquire without lease exhaustion", async () => {
    const host = setup({ limits: { maxServiceLeases: 32, maxServiceLeasesPerOwner: 32 } });
    const one = endpoint("lease-one");
    const two = endpoint("lease-two");
    const three = endpoint("lease-three");
    const out = endpoint("lease-out");

    for (const [token, name] of [
      [one, "one"],
      [two, "two"],
      [three, "three"],
    ] as const) {
      value(host.register(token, { run: () => Promise.resolve({ ok: true, value: name }) }));
    }

    value(
      await host.install([
        {
          name: "fanout",
          requires: { one, two, three },
          provides: { out },
          setup(ctx) {
            return ctx.service({
              out: {
                run(input: undefined, invocation: import("../../index").Invocation) {
                  const deps = invocation.deps as Record<
                    string,
                    { run(source: undefined): Promise<Result<string>> }
                  >;
                  const sources = [deps.one, deps.two, deps.three].map((entry) =>
                    entry!.run(undefined),
                  );
                  return Promise.all(sources).then((results) =>
                    results.every((result) => result.ok)
                      ? {
                          ok: true as const,
                          value: results.map((result) => (result.ok ? result.value : "")).join(","),
                        }
                      : { ok: false as const, error: results.find((result) => !result.ok)!.error },
                  );
                },
              },
            }) as never;
          },
        },
      ]),
    );
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
    expect(
      host.register(endpoint("owner-limit-extra"), {
        run: () => Promise.resolve({ ok: true, value: "extra" }),
      }),
    ).toMatchObject({ ok: true });
    value(await host.closeScope(holder));
    expect(host.use(first)).toMatchObject({ ok: true });
  });
});
