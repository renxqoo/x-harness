import { afterEach, describe, expect, it } from "vitest";
import { createHost, defineChain, defineService } from "../../index";
import type { Result, Host } from "../../index";
import { clock, deferred, flush, root, text, value } from "../../__test__/helpers";

const roots: Host[] = [];
afterEach(async () => { for (const host of roots.splice(0)) await host.close(); });
const setup = (options?: Parameters<typeof root>[0]) => { const host = root(options); roots.push(host); return host; };

describe("execution admission and fixed budgets", () => {
  it("polluted native signal accessors and listeners cannot escape admission or strand work", async () => {
    const host = setup();
    const token = value(defineChain({ name: "budget/signal", input: text, output: text }));
    value(host.register(token, (input) => ({ ok: true, value: input })));
    const controller = new AbortController();
    for (const name of ["aborted", "addEventListener", "removeEventListener"]) Object.defineProperty(controller.signal, name, { get() { throw new Error("polluted"); } });
    expect(await host.dispatch(token, "safe", { signal: controller.signal })).toEqual({ ok: true, value: "safe" });
    controller.abort();
    expect(await host.dispatch(token, "cancelled", { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(host.inspect().activeCalls).toBe(0);
    expect(await host.close()).toMatchObject({ ok: true });
  });
  it.each(["service", "chain"] as const)("%s input validation cannot reset the deadline or enter an expired implementation", async (kind) => {
    const time = clock(); const host = setup({ scheduler: time.scheduler, limits: { callTimeoutMs: 10 } });
    let entered = 0; let validated = 0;
    const validate = (input: unknown) => { validated += 1; time.jump(11); return text(input); };
    let result: Result<unknown, unknown>;
    if (kind === "service") {
      const token = value(defineService<{ run(input: string): Promise<Result<string>> }>({ name: "budget/service", methods: { run: { input: validate } } }));
      value(host.register(token, { run(input) { entered += 1; return Promise.resolve({ ok: true, value: input }); } }));
      result = await value(host.use(token)).run("input");
    } else {
      const token = value(defineChain({ name: "budget/chain", input: validate, output: text }));
      value(host.register(token, (input) => { entered += 1; return { ok: true, value: input }; }));
      result = await host.dispatch(token, "input");
    }
    expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect({ entered, validated }).toEqual({ entered: 0, validated: 1 });
    expect(host.inspect().activeCalls).toBe(0);
    expect(time.timers.size).toBe(0);
  });
  it("cancelled and saturated chain calls do not run input validators", async () => {
    const host = setup({ limits: { maxActiveCalls: 1 } });
    const gate = deferred<void>(); let validated = 0;
    const token = value(defineChain({ name: "budget/admission", input(input) { validated += 1; return text(input); }, output: text }));
    value(host.register(token, async (input) => { await gate.promise; return { ok: true, value: input }; }));
    const controller = new AbortController(); controller.abort();
    expect(await host.dispatch(token, "cancelled", { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(validated).toBe(0);
    const first = host.dispatch(token, "first"); await flush();
    expect(await host.dispatch(token, "full")).toMatchObject({ ok: false, error: { code: "resource-limit" } });
    expect(validated).toBe(1);
    gate.resolve(); expect(value(await first)).toBe("first");
  });
  it("wait deadline is enforced on delivery without depending on the timer firing", async () => {
    const time = clock(); const host = setup({ scheduler: time.scheduler });
    const gate = deferred<void>();
    const task = value(host.startTask({ label: "later", timeoutMs: 100, async run() { await gate.promise; return { ok: true, value: 7 }; } }));
    const waiting = host.wait(task, { timeoutMs: 10 });
    time.jump(11); gate.resolve();
    expect(await waiting).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(value(await host.wait(task))).toBe(7);
    expect(host.inspect().activeWaits).toBe(0); expect(time.timers.size).toBe(0);
  });
  it("concurrent wait admission is bounded and timed out subscriptions release their budget", async () => {
    const time = clock(); const host = setup({ scheduler: time.scheduler, limits: { maxActiveWaits: 1 } });
    const gate = deferred<void>();
    const task = value(host.startTask({ label: "target", async run() { await gate.promise; return { ok: true, value: 1 }; } }));
    const first = host.wait(task, { timeoutMs: 10 });
    expect(await host.wait(task)).toMatchObject({ ok: false, error: { code: "resource-limit" } });
    time.advance(10); expect(await first).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(host.inspect().activeWaits).toBe(0);
    gate.resolve(); expect(value(await host.wait(task))).toBe(1);
  });
  it("scheduler setup exceptions leave no registered work, counters or wait edges", async () => {
    const time = clock(); let fail = true;
    const host = setup({ scheduler: { now: () => time.scheduler.now(), delay(callback, ms) { if (fail) { fail = false; throw new Error("setup"); } return time.scheduler.delay(callback, ms); } } });
    const token = value(defineChain({ name: "budget/setup", input: text, output: text }));
    value(host.register(token, (input) => ({ ok: true, value: input })));
    expect(await host.dispatch(token, "input")).toMatchObject({ ok: false, error: { code: "callback-failed" } });
    expect(host.inspect()).toMatchObject({ activeCalls: 0, work: [] });
    expect(value(await host.dispatch(token, "next"))).toBe("next");
  });
  it.each([null, false, 0, ""])("explicit malformed root limits %s are rejected instead of adopting defaults", (limits) => {
    expect(createHost({ limits } as unknown as Parameters<typeof createHost>[0])).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });
});
