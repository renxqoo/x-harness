import { expect, it } from "vitest";
import { createHost, defineService } from "../../index";
import type { Result, Invocation } from "../../index";

function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));

  return r.value;
}

it.each(["cancelled", "timeout"] as const)(
  "self cancellation publishes %s before actual work ends",
  async (reason) => {
    const host = value(createHost());
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let saved: Invocation | undefined;
    const token = value(
      defineService<{ run(input: void): Promise<Result<void>> }>({
        name: "self-cancel",
        methods: { run: {} },
      }),
    );
    value(
      host.register(token, {
        async run(_i, call) {
          saved = call;
          value(call.cancel(reason));
          await gate;
          return { ok: true, value: undefined };
        },
      }),
    );

    try {
      expect(await value(host.use(token)).run(undefined)).toMatchObject({
        ok: false,
        error: { code: reason },
      });
      expect(host.inspect().activeCalls).toBe(1);
      expect(saved!.cancel("bad" as never)).toMatchObject({
        ok: false,
        error: { code: "invalid-input" },
      });
      release();
      value(await host.close());
      expect(saved!.cancel()).toMatchObject({ ok: false, error: { code: "cancelled" } });
    } finally {
      release();
      await host.close();
    }
  },
);

it.each(["cancelled", "timeout"] as const)(
  "nested wait preserves the first %s cause while native abort reasons stay private",
  async (reason) => {
    const host = value(createHost());
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let root: Invocation | undefined;
    let leaf: Invocation | undefined;
    let childReceipt: Result<void> | undefined;
    const token = value(
      defineService<{ run(input: void): Promise<Result<void>> }>({
        name: "nested-cancel",
        methods: { run: {} },
      }),
    );
    value(
      host.register(token, {
        async run(_input, call) {
          root = call;
          const task = value(
            call.spawn({
              label: "outer",
              async run(child) {
                leaf = child;
                const inner = value(
                  child.spawn({
                    label: "inner",
                    async run() {
                      entered();
                      await gate;
                      return { ok: true, value: undefined };
                    },
                  }),
                );
                childReceipt = await child.wait(inner);
                return childReceipt;
              },
            }),
          );
          return call.wait(task);
        },
      }),
    );

    try {
      const pending = value(host.use(token)).run(undefined);
      await started;
      value(root!.cancel(reason));
      value(root!.cancel(reason === "timeout" ? "cancelled" : "timeout"));
      expect(await pending).toMatchObject({ ok: false, error: { code: reason } });
      await Promise.resolve();
      expect(childReceipt).toMatchObject({ ok: false, error: { code: reason } });
      expect(leaf!.signal.reason).toBeInstanceOf(DOMException);
      expect(host.inspect().activeTasks).toBeGreaterThan(0);
    } finally {
      release();
      value(await host.close());
    }
  },
);
