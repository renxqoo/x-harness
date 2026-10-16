import { expect, it } from "vitest";
import { createHost, definePlugin } from "../../../core/src/index";
import type { Result, Scheduler } from "../../../core/src/index";
import { createTimer, createTimerPlugin, timer } from "../index";
import { clock, deferred, flush, value } from "./helpers";

const ok = (): Result<void> => ({ ok: true, value: undefined });

it("sleep settles or cancels and removes every scheduled timer", async () => {
  const time = clock(); const host = value(createHost({ scheduler: time.scheduler, limits: { callTimeoutMs: 10 } }));
  value(await host.install([value(createTimerPlugin({ scheduler: time.scheduler }))])); const service = value(host.use(timer));
  const pending = service.sleep({ ms: 5 }); await flush(); time.advance(5); value(await pending); expect(time.timers.size).toBe(0);
  const late = service.sleep({ ms: 20 }); await flush(); time.advance(10); expect(await late).toMatchObject({ ok: false, error: { code: "timeout" } });
  await flush(); expect(time.timers.size).toBe(0); value(await host.close());
});

it.each([-1, NaN, Infinity, 0.5, 2147483648])("sleep rejects invalid delay %s", async (ms) => {
  const host = value(createHost()); value(await host.install([value(createTimerPlugin())]));
  expect((await value(host.use(timer)).sleep({ ms })).ok).toBe(false); value(await host.close());
});

it("interval keeps running across task deadlines and never overlaps actual callbacks", async () => {
  const time = clock(); const host = value(createHost({ scheduler: time.scheduler, limits: { callTimeoutMs: 10 } })); const gate = deferred<Result<void>>(); let calls = 0;
  const timers = value(createTimer(host, { scheduler: time.scheduler }));
  const repeating = value(timers.interval({ ms: 6, run() { calls += 1; return calls === 2 ? gate.promise : ok(); } }));
  time.advance(6); await flush(); expect(calls).toBe(1); time.advance(6); await flush(); expect(calls).toBe(2);
  time.advance(100); await flush(); expect(calls).toBe(2); expect(repeating.state).toBe("running");
  gate.resolve(ok()); await flush(); expect(await repeating.finished).toMatchObject({ ok: false, error: { code: "timeout" } });
  expect(repeating.state).toBe("stopped"); expect(time.timers.size).toBe(0); value(await host.close());
});

it("healthy intervals run longer than the per-call timeout through finite task segments", async () => {
  const time = clock(); const host = value(createHost({ scheduler: time.scheduler, limits: { callTimeoutMs: 10 } })); let calls = 0;
  const repeating = value(value(createTimer(host, { scheduler: time.scheduler })).interval({ ms: 5, run() { calls += 1; return ok(); } }));
  for (let step = 0; step < 10; step += 1) { time.advance(5); await flush(); }
  expect(calls).toBe(10); value(repeating.cancel()); expect(await repeating.finished).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(time.timers.size).toBe(0); value(await host.close());
});

it("plugin timer callbacks preserve typed dependencies and stop on unload", async () => {
  const time = clock(); const host = value(createHost({ scheduler: time.scheduler })); let calls = 0;
  value(await host.install([value(createTimerPlugin({ scheduler: time.scheduler }))]));
  const loaded = value(await host.install([definePlugin({ name: "periodic", requires: { timer }, setup(ctx) {
    const timers = createTimer(ctx, { scheduler: time.scheduler }); if (!timers.ok) return timers;
    return timers.value.interval({ ms: 2, async run(call) { calls += 1; return call.deps.timer.sleep({ ms: 0 }); } });
  } })]));
  time.advance(2); await flush(); time.advance(0); await flush(); expect(calls).toBe(1);
  value(await host.uninstall(loaded.plugins[0]!)); time.advance(100); await flush(); expect(calls).toBe(1);
  expect(time.timers.size).toBe(0); value(await host.close());
});

it("timeouts release their own resource after success and cancellation is idempotent", async () => {
  const time = clock(); const host = value(createHost({ scheduler: time.scheduler })); const timers = value(createTimer(host, { scheduler: time.scheduler }));
  const scheduled = value(timers.timeout({ ms: 0, run: ok })); time.advance(0); await flush(); value(await scheduled.finished);
  expect(host.inspect().effects).toBe(0); value(scheduled.cancel());
  const other = value(timers.timeout({ ms: 10, run: ok })); value(other.cancel()); value(other.cancel());
  expect(await other.finished).toMatchObject({ ok: false, error: { code: "cancelled" } }); expect(time.timers.size).toBe(0); value(await host.close());
});

it("scheduled cancellation waits for actual callback completion and all child work", async () => {
  const time = clock(); const host = value(createHost({ scheduler: time.scheduler })); const gate = deferred<Result<void>>();
  const scheduled = value(value(createTimer(host, { scheduler: time.scheduler })).timeout({ ms: 0, run(call) { value(call.spawn({ label: "child", run: () => gate.promise })); return ok(); } }));
  time.advance(0); await flush(); value(scheduled.cancel()); let ended = false; void scheduled.finished.then(() => { ended = true; });
  await flush(); expect(ended).toBe(false); expect(host.inspect().activeTasks).toBe(2);
  gate.resolve(ok()); expect(await scheduled.finished).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(time.timers.size).toBe(0); expect(host.inspect().activeTasks).toBe(0); value(await host.close());
});

it("unobserved child failure stops a scheduled interval instead of starting another tick", async () => {
  const time = clock(); const host = value(createHost({ scheduler: time.scheduler })); let calls = 0;
  const scheduled = value(value(createTimer(host, { scheduler: time.scheduler })).interval({ ms: 1, run(call) {
    calls += 1; value(call.spawn({ label: "failed", run() { throw new Error("private"); } })); return ok();
  } }));
  time.advance(1); await flush(); expect(await scheduled.finished).toMatchObject({ ok: false, error: { code: "callback-failed" } });
  time.advance(100); await flush(); expect(calls).toBe(1); expect(time.timers.size).toBe(0); value(await host.close());
});

it("timer rejects malformed options, schedules, owners and stopped contexts", async () => {
  const host = value(createHost());
  const timers = value(createTimer(host));
  for (const spec of [null, { ms: 1, run: 1 }, { ms: -1, run: ok }, { ms: 1, run: ok, label: "" }, { ms: 1, run: ok, timeoutMs: 0 }, { ms: 1, run: ok, extra: true }]) {
    expect(timers.timeout(spec as Parameters<typeof timers.timeout>[0]).ok).toBe(false);
  }
  expect(timers.interval({ ms: 0, run: ok }).ok).toBe(false);
  expect(createTimerPlugin({ extra: 1 } as Parameters<typeof createTimerPlugin>[0]).ok).toBe(false);
  expect(createTimerPlugin({ scheduler: {} as Scheduler }).ok).toBe(false);
  expect(createTimer(host, { extra: true } as Parameters<typeof createTimer>[1]).ok).toBe(false);
  expect(createTimer({} as Parameters<typeof createTimer>[0]).ok).toBe(false);
  expect(createTimer({ signal: {}, addCleanup: ok, startTask: ok } as unknown as Parameters<typeof createTimer>[0]).ok).toBe(false);
  const hostile = Object.defineProperty({}, "addCleanup", { get() { throw new Error("getter must not execute"); } });
  expect(createTimer(hostile as Parameters<typeof createTimer>[0]).ok).toBe(false);
  value(await host.close()); expect(timers.timeout({ ms: 0, run: ok }).ok).toBe(false);
  expect(value(createTimer(host)).timeout({ ms: 0, run: ok }).ok).toBe(false);
});

it("scheduler exceptions and resource-capacity failures leave no scheduled work", async () => {
  const host = value(createHost({ limits: { maxEffects: 1 } })); value(host.addCleanup(ok));
  expect(value(createTimer(host)).timeout({ ms: 1, run: ok })).toMatchObject({ ok: false, error: { code: "resource-limit" } }); value(await host.close());
  const other = value(createHost()); const scheduler = { now: () => 0, delay() { throw new Error("private scheduler"); } };
  const pending = value(value(createTimer(other, { scheduler })).timeout({ ms: 1, run: ok }));
  expect(await pending.finished).toMatchObject({ ok: false, error: { code: "callback-failed" } }); value(await other.close());
  expect(createTimerPlugin({ scheduler: { now: () => NaN, delay: () => () => {} } }).ok).toBe(false);
  expect(createTimerPlugin({ scheduler: { now() { throw new Error("private"); }, delay: () => () => {} } }).ok).toBe(false);
});

it("saved timer tools and scheduled handles release the closed kernel", async () => {
  const child = Bun.spawn(["bun", new URL("./timer.gc-case.ts", import.meta.url).pathname], { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_JSC_useJIT: "false" } });
  const timeout = setTimeout(() => child.kill(), 5000);
  try {
    const [output, errors, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(errors).toBe(""); expect(status).toBe(0); expect(output).toBe("collected\n");
  } finally { clearTimeout(timeout); child.kill(); }
});

it("native timer services and scheduled callbacks drain all owned resources", async () => {
  const host = value(createHost()); value(await host.install([value(createTimerPlugin())]));
  value(await value(host.use(timer)).sleep({ ms: 0 })); let calls = 0;
  const task = value(value(createTimer(host)).timeout({ ms: 0, run() { calls += 1; return ok(); } }));
  value(await task.finished); expect(calls).toBe(1); expect(host.inspect().activeTasks).toBe(0); expect(host.inspect().effects).toBe(1); value(await host.close());
});

it("task admission failure stops the interval and releases its schedule", async () => {
  const time = clock(); const host = value(createHost({ scheduler: time.scheduler, limits: { maxActiveTasks: 1 } })); const gate = deferred<Result<void>>();
  const occupied = value(host.startTask({ label: "occupied", run: () => gate.promise }));
  const scheduled = value(value(createTimer(host, { scheduler: time.scheduler })).interval({ ms: 1, run: ok })); time.advance(1); await flush();
  expect(await scheduled.finished).toMatchObject({ ok: false, error: { code: "resource-limit" } }); expect(host.inspect().effects).toBe(0);
  gate.resolve(ok()); value(await occupied.finished); value(await host.close());
});
