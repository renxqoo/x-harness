import { expect, it } from "vitest";
import { createToolPlugin } from "../index";
import { world, value, emptySchema, request, text, deferred, flush } from "./helpers";
it("global capacity remains occupied after cancellation until the actual author exits", async () => {
  const gate = deferred();
  const entered = deferred();
  const { host, service } = await world(
    [
      value(
        createToolPlugin({
          name: "echo",
          inputSchema: emptySchema,
          concurrency: 2,
          async execute() {
            entered.resolve();
            await gate.promise;
            return text("late");
          },
        }),
      ),
    ],
    { access: "allow", limits: { maxActiveRequests: 1 } },
  );
  const abort = new AbortController();

  try {
    const first = service.execute({ ...request(), signal: abort.signal });
    await entered.promise;
    abort.abort();
    expect((await first).ok).toBe(false);
    expect(host.inspect().activeTasks).toBeGreaterThan(0);
    expect(await service.execute(request())).toMatchObject({ ok: false, error: { code: "busy" } });
    gate.resolve();
    await flush();
    expect((await service.execute(request())).ok).toBe(true);
  } finally {
    gate.resolve();
    await flush();
    value(await host.close());
  }
});
it("per tool capacity is exclusive by default while unrelated tools remain usable", async () => {
  const gate = deferred();
  const entered = deferred();
  const { host, service } = await world([
    value(
      createToolPlugin({
        name: "echo",
        inputSchema: emptySchema,
        async execute() {
          entered.resolve();
          await gate.promise;
          return text("x");
        },
      }),
    ),
    value(
      createToolPlugin({
        name: "other",
        inputSchema: emptySchema,
        execute: async () => text("other"),
      }),
    ),
  ]);

  try {
    const first = service.execute(request());
    await entered.promise;
    expect(await service.execute(request())).toMatchObject({ ok: false, error: { code: "busy" } });
    expect((await service.execute(request("other"))).ok).toBe(true);
    gate.resolve();
    value(await first);
  } finally {
    gate.resolve();
    value(await host.close());
  }
});
it("precancelled calls do not start the author", async () => {
  let count = 0;
  const { host, service } = await world([
    value(
      createToolPlugin({
        name: "echo",
        inputSchema: emptySchema,
        execute: async () => {
          count++;
          return text("x");
        },
      }),
    ),
  ]);

  try {
    const abort = new AbortController();
    abort.abort();
    expect(await service.execute({ ...request(), signal: abort.signal })).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(count).toBe(0);
  } finally {
    value(await host.close());
  }
});
it("plugin removal aborts running work and awaits its actual completion", async () => {
  const entered = deferred();
  let aborted = false;
  const tool = value(
    createToolPlugin({
      name: "echo",
      inputSchema: emptySchema,
      async execute(_i, call) {
        entered.resolve();
        await new Promise<void>((resolve) =>
          call.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        return text("late");
      },
    }),
  );
  const { host, service } = await world();

  try {
    const installed = value(await host.install([tool]));
    const first = service.execute(request());
    await entered.promise;
    value(await host.uninstall(installed.plugins[0]!));
    expect((await first).ok).toBe(false);
    expect(aborted).toBe(true);
    expect(value(await service.list({}))).toEqual([]);
    expect(host.inspect().activeTasks).toBe(0);
  } finally {
    value(await host.close());
  }
});
it("explicit request abort returns before a noncooperative author exits", async () => {
  const gate = deferred();
  const entered = deferred();
  const { host, service } = await world([
    value(
      createToolPlugin({
        name: "echo",
        inputSchema: emptySchema,
        async execute() {
          entered.resolve();
          await gate.promise;
          return text("late");
        },
      }),
    ),
  ]);

  try {
    const abort = new AbortController();
    const running = service.execute({ ...request(), signal: abort.signal });
    await entered.promise;
    abort.abort();
    expect(
      await Promise.race([
        running,
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
      ]),
    ).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(host.inspect().activeTasks).toBeGreaterThan(0);
    gate.resolve();
  } finally {
    gate.resolve();
    value(await host.close());
  }
});
it("explicit request timeout returns before actual work without releasing capacity", async () => {
  const gate = deferred();
  const { host, service } = await world(
    [
      value(
        createToolPlugin({
          name: "echo",
          inputSchema: emptySchema,
          execute: async () => {
            await gate.promise;
            return text("late");
          },
        }),
      ),
    ],
    { access: "allow", limits: { maxActiveRequests: 1 } },
  );

  try {
    const running = service.execute({ ...request(), timeoutMs: 10 });
    expect(
      await Promise.race([
        running,
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 80)),
      ]),
    ).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(await service.execute(request())).toMatchObject({ ok: false, error: { code: "busy" } });
  } finally {
    gate.resolve();
    value(await host.close());
  }
});
it("a shorter tool deadline reaches the caller before an uncooperative author exits", async () => {
  const gate = deferred();
  const { host, service } = await world([
    value(
      createToolPlugin({
        name: "echo",
        inputSchema: emptySchema,
        limits: { timeoutMs: 10 },
        execute: async () => {
          await gate.promise;
          return text("late");
        },
      }),
    ),
  ]);

  try {
    expect(
      await Promise.race([
        service.execute(request()),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 80)),
      ]),
    ).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(host.inspect().activeTasks).toBeGreaterThan(0);
  } finally {
    gate.resolve();
    value(await host.close());
  }
});
it("unloading signals failure before a noncooperative author actually exits", async () => {
  const gate = deferred();
  const entered = deferred();
  const { host, service } = await world();
  let removal: Promise<unknown> | undefined;

  try {
    const installed = value(
      await host.install([
        value(
          createToolPlugin({
            name: "echo",
            inputSchema: emptySchema,
            execute: async () => {
              entered.resolve();
              await gate.promise;
              return text("late");
            },
          }),
        ),
      ]),
    );
    const running = service.execute(request());
    await entered.promise;
    removal = host.uninstall(installed.plugins[0]!);
    expect(
      await Promise.race([
        running,
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 80)),
      ]),
    ).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(host.inspect().activeTasks).toBeGreaterThan(0);
  } finally {
    gate.resolve();
    await removal;
    value(await host.close());
  }
});
it("injected scheduler timeout preserves its reason before derived child cancellation", async () => {
  let now = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  const { createHost } = await import("../../../../core/src/index");
  const { createToolsPlugin, tools } = await import("../index");
  const host = value(
    createHost({
      scheduler: {
        now: () => now,
        delay(run, ms) {
          const timer = { at: now + ms, run };
          timers.add(timer);

          return () => {
            timers.delete(timer);
          };
        },
      },
      limits: { callTimeoutMs: 5000 },
    }),
  );
  const gate = deferred();
  const entered = deferred();

  try {
    value(
      await host.install([
        value(createToolsPlugin({ access: "allow" })),
        value(
          createToolPlugin({
            name: "echo",
            inputSchema: emptySchema,
            execute: async () => {
              entered.resolve();
              await gate.promise;
              return text("late");
            },
          }),
        ),
      ]),
    );
    const running = value(host.use(tools)).execute({ ...request(), timeoutMs: 1000 });
    await entered.promise;
    now = 1001;

    for (const timer of [...timers].sort((a, b) => a.at - b.at))
      if (timer.at <= now) {
        timers.delete(timer);
        timer.run();
      }

    expect(
      await Promise.race([
        running,
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
      ]),
    ).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(host.inspect().activeTasks).toBeGreaterThan(0);
  } finally {
    gate.resolve();
    value(await host.close());
  }
});
