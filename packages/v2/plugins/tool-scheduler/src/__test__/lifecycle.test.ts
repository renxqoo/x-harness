import { expect, it } from "vitest";
import { createToolPlugin } from "../../../tools/src/index";
import { world, value, text, gate, request, flush } from "./helpers";
it("a cancelled noncooperative author keeps global and per-tool capacity until actual exit", async () => {
  const hold = gate(),
    entered = gate();
  let runs = 0;
  const { host, service } = await world(
    [
      value(
        createToolPlugin({
          name: "echo",
          concurrency: 3,
          inputSchema: { type: "object" },
          execute: async () => {
            runs++;
            entered.resolve();
            await hold.promise;
            return text("x");
          },
        }),
      ),
    ],
    { concurrency: 1 },
  );

  try {
    const abort = new AbortController();
    const first = service.execute({ ...request(), signal: abort.signal });
    await entered.promise;
    abort.abort();
    expect(await first).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(value(await service.inspect({})).running).toBe(1);
    const next = service.execute({ ...request(), callId: "next" });
    await expect.poll(async () => value(await service.inspect({})).queued).toBe(1);
    expect(runs).toBe(1);
    hold.resolve();
    value(await next);
    await flush();
    expect(value(await service.inspect({}))).toEqual({ running: 0, queued: 0, requests: 0 });
  } finally {
    hold.resolve();
    value(await host.close());
  }
});
it("the total request deadline includes queue waiting and does not start the expired author", async () => {
  const hold = gate(),
    entered = gate();
  let runs = 0;
  const { host, service } = await world(
    [
      value(
        createToolPlugin({
          name: "echo",
          inputSchema: { type: "object" },
          execute: async () => {
            runs++;
            entered.resolve();
            await hold.promise;
            return text("x");
          },
        }),
      ),
    ],
    { concurrency: 1 },
  );

  try {
    const first = service.execute(request());
    await entered.promise;
    expect(await service.execute({ ...request(), timeoutMs: 20 })).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    hold.resolve();
    value(await first);
    expect(runs).toBe(1);
  } finally {
    hold.resolve();
    value(await host.close());
  }
});
it("queue capacity is reserved atomically for the complete batch", async () => {
  const hold = gate(),
    entered = gate();
  let runs = 0;
  const { host, service } = await world(
    [
      value(
        createToolPlugin({
          name: "echo",
          concurrency: 3,
          inputSchema: { type: "object" },
          execute: async () => {
            runs++;
            entered.resolve();
            await hold.promise;
            return text("x");
          },
        }),
      ),
    ],
    { concurrency: 1, maxOutstandingCalls: 2 },
  );

  try {
    const first = service.execute(request());
    await entered.promise;
    expect(
      await service.batch({ calls: [request("echo", "a"), request("echo", "b")] }),
    ).toMatchObject({ ok: false, error: { code: "queue-full" } });
    expect(runs).toBe(1);
    expect(value(await service.inspect({})).queued).toBe(0);
    hold.resolve();
    value(await first);
  } finally {
    hold.resolve();
    value(await host.close());
  }
});
it("closing the host cancels queued work and signals running tools", async () => {
  const entered = gate();
  let aborted = false,
    runs = 0;
  const { host, service } = await world(
    [
      value(
        createToolPlugin({
          name: "echo",
          inputSchema: { type: "object" },
          execute: async (_i, call) => {
            runs++;
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
            return text("x");
          },
        }),
      ),
    ],
    { concurrency: 1 },
  );

  try {
    const first = service.execute(request());
    await entered.promise;
    const second = service.execute({ ...request(), callId: "queued" });
    await expect.poll(async () => value(await service.inspect({})).queued).toBe(1);
    value(await host.close());
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(false);
    expect(aborted).toBe(true);
    expect(runs).toBe(1);
    expect(host.inspect()).toMatchObject({ activeCalls: 0, activeTasks: 0 });
  } finally {
    await host.close();
  }
});
it("a node deadline does not cancel an independent batch node", async () => {
  const { host, service } = await world([
    value(
      createToolPlugin({
        name: "echo",
        concurrency: 2,
        inputSchema: { type: "object" },
        execute: async (_i, call) => {
          if (call.callId === "slow")
            await new Promise<void>((resolve) =>
              call.signal.addEventListener("abort", () => resolve(), { once: true }),
            );

          return text("x");
        },
      }),
    ),
  ]);

  try {
    const report = value(
      await service.batch({
        calls: [{ ...request("echo", "slow"), timeoutMs: 20 }, request("echo", "good")],
      }),
    );
    expect(report.results[0]!.result).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(report.results[1]!.result.ok).toBe(true);
  } finally {
    value(await host.close());
  }
});
it("request capacity remains reserved while its cancelled author has not exited", async () => {
  const hold = gate(),
    entered = gate();
  const { host, service } = await world(
    [
      value(
        createToolPlugin({
          name: "echo",
          inputSchema: { type: "object" },
          execute: async () => {
            entered.resolve();
            await hold.promise;
            return text("x");
          },
        }),
      ),
    ],
    { maxRequests: 1 },
  );

  try {
    const abort = new AbortController();
    const first = service.execute({ ...request(), signal: abort.signal });
    await entered.promise;
    abort.abort();
    expect((await first).ok).toBe(false);
    const attempt = service.execute(request("echo", "next"));
    expect(
      await Promise.race([
        attempt,
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
      ]),
    ).toMatchObject({ ok: false, error: { code: "queue-full" } });
  } finally {
    hold.resolve();
    value(await host.close());
  }
});
it("unloading the scheduler cancels waiting and running calls and drains its owned work", async () => {
  const entered = gate();
  let runs = 0;
  const { host, service, scheduler } = await world(
    [
      value(
        createToolPlugin({
          name: "echo",
          inputSchema: { type: "object" },
          execute: async (_i, call) => {
            runs++;
            entered.resolve();
            await new Promise<void>((resolve) =>
              call.signal.addEventListener("abort", () => resolve(), { once: true }),
            );
            return text("x");
          },
        }),
      ),
    ],
    { concurrency: 1 },
  );

  try {
    const first = service.execute(request());
    await entered.promise;
    const second = service.execute(request("echo", "queued"));
    await expect.poll(async () => value(await service.inspect({})).queued).toBe(1);
    value(await host.uninstall(scheduler));
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(false);
    expect(runs).toBe(1);
    expect(host.inspect()).toMatchObject({ activeCalls: 0, activeTasks: 0 });
  } finally {
    value(await host.close());
  }
});
it("a precancelled request never reserves lasting queue capacity", async () => {
  const { host, service } = await world();

  try {
    const abort = new AbortController();
    abort.abort();
    expect(await service.execute({ ...request(), signal: abort.signal })).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
    await flush();
    expect(value(await service.inspect({}))).toEqual({ running: 0, queued: 0, requests: 0 });
  } finally {
    value(await host.close());
  }
});
it("a queued name is bound to its current tool installation at execution time", async () => {
  const hold = gate(),
    entered = gate();
  const { host, service } = await world(
    [
      value(
        createToolPlugin({
          name: "block",
          inputSchema: { type: "object" },
          execute: async () => {
            entered.resolve();
            await hold.promise;
            return text("x");
          },
        }),
      ),
    ],
    { concurrency: 1 },
  );

  try {
    const old = value(
      await host.install([
        value(
          createToolPlugin({
            name: "echo",
            inputSchema: { type: "object" },
            execute: async () => text("old"),
          }),
        ),
      ]),
    );
    const first = service.execute(request("block", "block"));
    await entered.promise;
    const next = service.execute(request());
    await expect.poll(async () => value(await service.inspect({})).queued).toBe(1);
    value(await host.uninstall(old.plugins[0]!));
    value(
      await host.install([
        value(
          createToolPlugin({
            name: "echo",
            inputSchema: { type: "object" },
            execute: async () => text("new"),
          }),
        ),
      ]),
    );
    hold.resolve();
    value(await first);
    expect(value(await next).content).toEqual([{ type: "text", text: "new" }]);
  } finally {
    hold.resolve();
    value(await host.close());
  }
});
it("core task admission failure releases all scheduler reservations", async () => {
  const { createHost } = await import("../../../../core/src/index");
  const { createToolsPlugin } = await import("../../../tools/src/index");
  const { createToolSchedulerPlugin, toolScheduler } = await import("../index");
  const host = value(createHost({ limits: { maxActiveTasks: 1 } }));

  try {
    value(
      await host.install([
        value(createToolsPlugin({ access: "allow" })),
        value(createToolSchedulerPlugin({ access: "allow" })),
        value(
          createToolPlugin({
            name: "echo",
            inputSchema: { type: "object" },
            execute: async () => text("x"),
          }),
        ),
      ]),
    );
    const service = value(host.use(toolScheduler));

    for (let i = 0; i < 2; i++) {
      expect(await service.execute(request())).toMatchObject({
        ok: false,
        error: { source: "core", code: "resource-limit" },
      });
      expect(value(await service.inspect({}))).toEqual({ running: 0, queued: 0, requests: 0 });
    }
  } finally {
    value(await host.close());
  }
});
it.each(["wait", "immediate"] as const)(
  "nested submission into the saturated scheduler remains bounded in %s mode",
  async (mode) => {
    const { toolScheduler } = await import("../index");
    let runs = 0;
    const { host, service } = await world(
      [
        value(
          createToolPlugin({
            name: "echo",
            requires: { scheduler: toolScheduler },
            inputSchema: { type: "object" },
            async execute(_input, call) {
              runs++;
              const nested = await call.deps.scheduler.execute({
                ...request("echo", "nested"),
                mode,
              });

              if (!nested.ok && nested.error.code === "busy") return text("busy");

              return {
                ok: false,
                error: { source: "tools", code: "execution-failed", message: "execution-failed" },
              };
            },
          }),
        ),
      ],
      { concurrency: 1 },
    );

    try {
      const result = await service.execute({ ...request(), timeoutMs: 100 });

      if (mode === "immediate")
        expect(value(result).content).toEqual([{ type: "text", text: "busy" }]);
      else expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });

      await expect
        .poll(async () => value(await service.inspect({})))
        .toEqual({ running: 0, queued: 0, requests: 0 });
      expect(runs).toBe(1);
    } finally {
      value(await host.close());
    }
  },
);
