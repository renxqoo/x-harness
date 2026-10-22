import { afterEach, describe, expect, it } from "vitest";
import { defineChain, defineEvent, defineGuard, defineService } from "../../index";
import type { Result, Host } from "../../index";
import { clock, number, root, text, value } from "../../__test__/helpers";

const roots: Host[] = [];
afterEach(async () => {
  for (const item of roots.splice(0)) await item.close();
});

const setup = (options?: Parameters<typeof root>[0]) => {
  const item = root(options);
  roots.push(item);
  return item;
};

const throwing = (): never => {
  throw new Error("private validator detail");
};

describe("validator exception classification", () => {
  it.each(["input", "output", "failure"] as const)(
    "service %s validator exceptions remain callback-failed",
    async (field) => {
      const host = setup();
      const token = value(
        defineService<{ run(input: string): Promise<Result<number, string>> }>({
          name: `service-${field}`,
          methods: { run: { [field]: throwing } },
        }),
      );
      let entered = 0;
      value(
        host.register(token, {
          run: () => {
            entered += 1;
            return Promise.resolve(
              field === "failure" ? { ok: false, error: "domain" } : { ok: true, value: 1 },
            );
          },
        }),
      );
      const result = await value(host.use(token)).run("input");
      expect(result).toMatchObject({ ok: false, error: { code: "callback-failed" } });
      expect(entered).toBe(field === "input" ? 0 : 1);
      expect(JSON.stringify(result)).not.toContain("private validator detail");
      expect(host.inspect().activeCalls).toBe(0);
    },
  );
  it.each(["input", "output"] as const)(
    "chain %s validator exceptions remain callback-failed",
    async (field) => {
      const host = setup();
      const token = value(
        defineChain({
          name: `chain-${field}`,
          input: field === "input" ? throwing : text,
          output: field === "output" ? throwing : number,
        }),
      );
      value(host.register(token, () => ({ ok: true, value: 1 })));
      expect(await host.dispatch(token, "input")).toMatchObject({
        ok: false,
        error: { code: "callback-failed" },
      });
      expect(host.inspect().activeCalls).toBe(0);
    },
  );
  it("an event payload validator exception allocates no listener deliveries", () => {
    const host = setup();
    const token = value(defineEvent<string>({ name: "event", payload: throwing }));
    let entered = 0;
    value(host.register(token));
    value(
      host.on(token, () => {
        entered += 1;
      }),
    );
    expect(host.emit(token, "input")).toMatchObject({
      ok: false,
      error: { code: "callback-failed" },
    });
    expect(host.inspect().pendingEvents).toBe(0);
    expect(entered).toBe(0);
  });
  it("a guard validator exception cannot enter an allowing handler", async () => {
    const host = setup();
    const token = value(defineGuard<string>({ name: "guard", input: throwing }));
    let entered = 0;
    value(host.register(token));
    value(
      host.guard(token, () => {
        entered += 1;
        return { ok: true, value: { kind: "allow" } };
      }),
    );
    expect(await host.dispatch(token, "input")).toMatchObject({
      ok: false,
      error: { code: "callback-failed" },
    });
    expect(entered).toBe(0);
  });
  it("schema rejection of a service output remains invalid-result", async () => {
    const host = setup();
    const token = value(
      defineService<{ run(input: string): Promise<Result<number>> }>({
        name: "schema",
        methods: {
          run: {
            output: () => ({
              ok: false,
              error: { source: "core", code: "invalid-input", message: "invalid-input" },
            }),
          },
        },
      }),
    );
    value(host.register(token, { run: () => Promise.resolve({ ok: true, value: 1 }) }));
    expect(await value(host.use(token)).run("input")).toMatchObject({
      ok: false,
      error: { code: "invalid-result" },
    });
  });
  it("chain output validation remains inside the invocation deadline", async () => {
    const time = clock();
    const host = setup({ scheduler: time.scheduler });
    const token = value(
      defineChain({
        name: "validation-budget",
        input: text,
        output: (input) => {
          time.jump(11);
          return number(input);
        },
      }),
    );
    value(host.register(token, () => ({ ok: true, value: 1 })));
    expect(await host.dispatch(token, "input", { timeoutMs: 10 })).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    expect(time.timers.size).toBe(0);
  });
});
