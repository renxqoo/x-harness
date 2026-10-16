import { expect, it } from "vitest";
import { defineService } from "../../index";
import type { Result } from "../../index";
import { clock, root, value } from "../../__test__/helpers";

it.each(["service", "task"] as const)("a returned %s result accessor is rejected without running it or retaining work", async (kind) => {
  const time = clock(); const host = root({ scheduler: time.scheduler }); let reads = 0;
  const returned = { ok: true, get value() { reads++; throw new Error("private result accessor"); } } as Result<unknown>;
  try {
    const service = value(defineService<{ read(input: void): Promise<Result<unknown>> }>({ name: "result-boundary", methods: { read: {} } }));
    let result: Result<unknown>;
    if (kind === "service") {
      value(host.register(service, { read: () => Promise.resolve(returned) })); result = await value(host.use(service)).read(undefined);
    } else {
      const task = value(host.startTask({ label: "result-boundary", run: () => returned })); result = await host.wait(task); await task.finished;
    }
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-result" } }); expect(reads).toBe(0);
    expect(host.inspect().work).toEqual([]); expect(host.inspect().activeCalls).toBe(0); expect(host.inspect().activeTasks).toBe(0); expect(host.inspect().activeWaits).toBe(0); expect(time.timers.size).toBe(0);
  } finally { value(await host.close()); }
});
