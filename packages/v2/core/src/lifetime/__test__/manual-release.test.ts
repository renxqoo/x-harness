import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createHost, defineService } from "../../index";
import type { Result, Scheduler } from "../../index";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush() {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

function clock() {
  let time = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  const scheduler: Scheduler = {
    now: () => time,
    delay(run, delayMs) {
      const timer = { at: time + delayMs, run };
      timers.add(timer);

      return () => {
        timers.delete(timer);
      };
    },
  };
  return {
    scheduler,
    timers,
    advance(ms: number) {
      time += ms;

      for (const timer of timers)
        if (timer.at <= time) {
          timers.delete(timer);
          timer.run();
        }
    },
  };
}

it("a hanging manual disposer returns close-incomplete within its fixed cleanup budget", async () => {
  const time = clock();
  const host = value(createHost({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } }));
  const gate = deferred<Result<void>>();
  const off = value(host.addCleanup(() => gate.promise));
  const releasing = off();

  try {
    await flush();
    time.advance(10);
    expect(await releasing).toMatchObject({ ok: false, error: { code: "close-incomplete" } });
    expect(host.inspect().effects).toBe(1);
  } finally {
    gate.resolve({ ok: true, value: undefined });
    await flush();
    value(await host.close());
  }

  expect(host.inspect().effects).toBe(0);
  expect(time.timers.size).toBe(0);
});

it("manual release budget keeps pins until a cleanup service finishes after outward timeout", async () => {
  const time = clock();
  const host = value(
    createHost({ scheduler: time.scheduler, limits: { callTimeoutMs: 5, closeTimeoutMs: 10 } }),
  );
  const token = value(
    defineService<{ run(input: void): Promise<Result<void>> }>({
      name: "cleanup/manual-drain",
      methods: { run: {} },
    }),
  );
  const gate = deferred<void>();
  value(
    host.register(token, {
      async run() {
        await gate.promise;
        return { ok: true, value: undefined };
      },
    }),
  );
  const off = value(
    host.addCleanup(async (call) => {
      await value(call.context.use(token)).run(undefined);
      return { ok: true, value: undefined };
    }),
  );
  const releasing = off();

  try {
    await flush();
    time.advance(5);
    await flush();
    expect(host.inspect()).toMatchObject({ activeCalls: 1, effects: 2 });
    time.advance(5);
    expect(await releasing).toMatchObject({ ok: false, error: { code: "close-incomplete" } });
    expect(host.inspect()).toMatchObject({ activeCalls: 1, effects: 2 });
  } finally {
    gate.resolve();
    await flush();
    value(await host.close());
  }

  expect(time.timers.size).toBe(0);
});

it("concurrent and later manual release reuse their first outward result after actual late success", async () => {
  const time = clock();
  const host = value(createHost({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } }));
  const gate = deferred<Result<void>>();
  let calls = 0;
  const off = value(
    host.addCleanup(() => {
      calls += 1;
      return gate.promise;
    }),
  );
  const first = off();
  expect(off()).toBe(first);

  try {
    await flush();
    time.advance(10);
    expect(await first).toMatchObject({ ok: false, error: { code: "close-incomplete" } });
    gate.resolve({ ok: true, value: undefined });
    await flush();
    expect(off()).toBe(first);
    expect(await off()).toMatchObject({ ok: false, error: { code: "close-incomplete" } });
    expect(calls).toBe(1);
    expect(host.inspect().effects).toBe(0);
  } finally {
    gate.resolve({ ok: true, value: undefined });
    value(await host.close());
  }
});

it("a saved timed-out release handle does not retain its successfully drained kernel", async () => {
  const child = Bun.spawn(
    ["bun", fileURLToPath(new URL("./collect-manual-release.gc-case.ts", import.meta.url))],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill(), 10000);

  try {
    const [output, error, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(error).toBe("");
    expect(status).toBe(0);
    expect(output).toBe("manual release handle idempotent\n");
  } finally {
    clearTimeout(timer);
    child.kill();
  }
});
