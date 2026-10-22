import { describe, expect, it, vi } from "vitest";
import type { Invocation, Result } from "../../index";
import { clock, deferred, flush, root, value } from "../../__test__/helpers";
import * as signals from "../../contracts/observe-signal";

describe("owned and external cancellation", () => {
  it("an options signal aliased to the owner is subscribed only once", async () => {
    const app = root();
    const gate = deferred<void>();
    const native = vi.spyOn(signals, "observeSignal");

    try {
      const task = value(
        app.startTask({
          label: "alias",
          signal: app.signal,
          async run() {
            await gate.promise;
            return { ok: true, value: undefined };
          },
        }),
      );
      await flush();
      expect(native.mock.calls.filter(([signal]) => signal === app.signal)).toHaveLength(1);
      app.signal.dispatchEvent(new Event("abort"));
      expect(await app.wait(task)).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(app.inspect().activeTasks).toBe(1);
      gate.resolve();
      await task.finished;
      expect(app.inspect().activeTasks).toBe(0);
    } finally {
      native.mockRestore();
      gate.resolve();
      value(await app.close());
    }
  });

  it.each([true, false])(
    "external cancellation retains first-result order when a source listener advances the clock: listenerFirst=%s",
    async (listenerFirst) => {
      const time = clock();
      const app = root({ scheduler: time.scheduler, limits: { callTimeoutMs: 100 } });
      const source = new AbortController();
      const gate = deferred<void>();

      const expire = () => time.advance(10);

      let call!: Invocation;

      if (listenerFirst) source.signal.addEventListener("abort", expire, { once: true });

      const task = value(
        app.startTask({
          label: "race",
          timeoutMs: 10,
          signal: source.signal,
          async run(current) {
            call = current;
            await gate.promise;
            return { ok: true, value: undefined };
          },
        }),
      );
      await flush();

      if (!listenerFirst) source.signal.addEventListener("abort", expire, { once: true });

      source.abort({ private: "reason" });
      expect(await app.wait(task)).toMatchObject({
        ok: false,
        error: { code: listenerFirst ? "timeout" : "cancelled" },
      });
      expect(call.signal.reason).not.toBe(source.signal.reason);
      expect(call.signal.reason).toBeInstanceOf(DOMException);
      expect(app.inspect().activeTasks).toBe(1);
      gate.resolve();
      await task.finished;
      expect(app.inspect().activeTasks).toBe(0);
      expect(time.timers.size).toBe(0);
      value(await app.close());
    },
  );

  it("an idle lifetime observer settles cancellation before a later source listener advances the clock", async () => {
    const time = clock();
    const app = root({ scheduler: time.scheduler });
    const gate = deferred<void>();
    const warm = value(
      app.startTask({
        label: "warm",
        run() {
          return { ok: true, value: undefined };
        },
      }),
    );
    await warm.finished;
    app.signal.addEventListener("abort", () => time.advance(10), { once: true });
    const task = value(
      app.startTask({
        label: "owned-race",
        timeoutMs: 10,
        async run() {
          await gate.promise;
          return { ok: true, value: undefined };
        },
      }),
    );
    await flush();
    app.signal.dispatchEvent(new Event("abort"));
    expect(await app.wait(task)).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(app.inspect().activeTasks).toBe(1);
    gate.resolve();
    await task.finished;
    expect(app.inspect().activeTasks).toBe(0);
    expect(time.timers.size).toBe(0);
    value(await app.close());
  });

  it("parent signal aliases still cancel children and retain the budget until actual completion", async () => {
    const app = root();
    const gate = deferred<void>();
    let child: { finished: Promise<Result<void>> } | undefined;
    const parent = value(
      app.startTask({
        label: "parent",
        async run(call) {
          child = value(
            call.spawn({
              label: "child",
              signal: call.signal,
              async run() {
                await gate.promise;
                return { ok: true, value: undefined };
              },
            }),
          );
          await gate.promise;
          return { ok: true, value: undefined };
        },
      }),
    );
    await flush();
    value(parent.cancel());
    expect(await app.wait(parent)).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(app.inspect().activeTasks).toBe(2);
    gate.resolve();
    await parent.finished;
    await child!.finished;
    expect(app.inspect()).toMatchObject({ activeTasks: 0, activeWaits: 0 });
    value(await app.close());
  });

  it("cancellation injected by the clock before subscribing never enters the body", async () => {
    const time = clock();
    const source = new AbortController();
    let inject = false;
    let entered = 0;
    const app = root({
      scheduler: {
        now() {
          if (inject) {
            inject = false;
            source.abort();
          }

          return time.scheduler.now();
        },
        delay: (callback, delayMs) => time.scheduler.delay(callback, delayMs),
      },
    });
    inject = true;
    const task = value(
      app.startTask({
        label: "reentrant",
        signal: source.signal,
        run() {
          entered++;
          return { ok: true, value: undefined };
        },
      }),
    );
    expect(await app.wait(task)).toMatchObject({ ok: false, error: { code: "cancelled" } });
    await task.finished;
    expect(entered).toBe(0);
    expect(app.inspect().activeTasks).toBe(0);
    expect(time.timers.size).toBe(0);
    value(await app.close());
  });
});
