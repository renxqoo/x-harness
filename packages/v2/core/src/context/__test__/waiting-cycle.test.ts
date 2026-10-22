import { expect, it } from "vitest";
import type { TaskHandle } from "../../index";
import { clock, deferred, root, value } from "../../__test__/helpers";

it("three independent tasks reject a transitive wait cycle and drain every waiter", async () => {
  const time = clock();
  const host = root({ scheduler: time.scheduler });
  const gate = deferred<void>();
  let a!: TaskHandle<string>;
  let b!: TaskHandle<string>;
  let c!: TaskHandle<string>;

  try {
    a = value(
      host.startTask({
        label: "a",
        async run(call) {
          await gate.promise;
          return call.wait(b);
        },
      }),
    );
    b = value(
      host.startTask({
        label: "b",
        async run(call) {
          await gate.promise;
          return call.wait(c);
        },
      }),
    );
    c = value(
      host.startTask({
        label: "c",
        async run(call) {
          await gate.promise;
          return call.wait(a);
        },
      }),
    );
    gate.resolve();
    const results = await Promise.all([host.wait(a), host.wait(b), host.wait(c)]);

    for (const result of results)
      expect(result).toMatchObject({ ok: false, error: { code: "wait-cycle" } });

    await Promise.all([a.finished, b.finished, c.finished]);
    expect(host.inspect().activeTasks).toBe(0);
    expect(host.inspect().activeWaits).toBe(0);
    expect(host.inspect().work).toEqual([]);
    expect(time.timers.size).toBe(0);
  } finally {
    gate.resolve();
    value(await host.close());
  }
});
