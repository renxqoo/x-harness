import { expect, it } from "vitest";
import { createToolPlugin } from "../../../tools/src/index";
import { world, value, gate, text, flush, request } from "./helpers";
it("a waiting call starts only after actual capacity is released", async () => {
  const hold = gate();
  const entered = gate();
  let count = 0;
  const { host, service } = await world(
    [
      value(
        createToolPlugin({
          name: "echo",
          concurrency: 2,
          inputSchema: { type: "object" },
          async execute() {
            if (++count === 1) {
              entered.resolve();
              await hold.promise;
            }

            return text(String(count));
          },
        }),
      ),
    ],
    { concurrency: 1 },
  );

  try {
    const first = service.execute(request());
    await entered.promise;
    const second = service.execute({ ...request(), callId: "second" });
    await flush();
    expect(count).toBe(1);
    expect(value(await service.inspect({}))).toMatchObject({ running: 1, queued: 1 });
    hold.resolve();
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(count).toBe(2);
  } finally {
    hold.resolve();
    value(await host.close());
  }
});
it("immediate mode returns busy without leaving a queued request", async () => {
  const hold = gate();
  const entered = gate();
  const { host, service } = await world(
    [
      value(
        createToolPlugin({
          name: "echo",
          inputSchema: { type: "object" },
          async execute() {
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
    expect(await service.execute({ ...request(), mode: "immediate" })).toMatchObject({
      ok: false,
      error: { source: "tool-scheduler", code: "busy" },
    });
    expect(value(await service.inspect({})).queued).toBe(0);
    hold.resolve();
    value(await first);
  } finally {
    hold.resolve();
    value(await host.close());
  }
});
it("cancelling queued work never calls the author and removes its queue entry", async () => {
  const hold = gate();
  const entered = gate();
  let count = 0;
  const { host, service } = await world(
    [
      value(
        createToolPlugin({
          name: "echo",
          inputSchema: { type: "object" },
          async execute() {
            count++;
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
    const abort = new AbortController();
    const pending = service.execute({ ...request(), signal: abort.signal });
    await flush();
    abort.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
    await flush();
    expect(value(await service.inspect({})).queued).toBe(0);
    hold.resolve();
    value(await first);
    expect(count).toBe(1);
  } finally {
    hold.resolve();
    value(await host.close());
  }
});
it("tools busy from direct competing callers is preserved without automatic retries", async () => {
  const hold = gate(),
    entered = gate();
  let runs = 0;
  const { tools } = await import("../../../tools/src/index");
  const { host, service } = await world([
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
  ]);

  try {
    const direct = value(host.use(tools)).execute(request());
    await entered.promise;
    expect(await service.execute(request())).toMatchObject({
      ok: false,
      error: { source: "tools", code: "busy" },
    });
    expect(runs).toBe(1);
    hold.resolve();
    value(await direct);
  } finally {
    hold.resolve();
    value(await host.close());
  }
});
it("asynchronous preparation cannot overcommit the global capacity while another author is blocked", async () => {
  const hold = gate(),
    firstEntered = gate(),
    secondEntered = gate();
  let runs = 0;
  const { host, service } = await world(
    [
      value(
        createToolPlugin({
          name: "echo",
          concurrency: 4,
          inputSchema: { type: "object" },
          async execute() {
            runs++;

            if (runs === 1) firstEntered.resolve();
            else secondEntered.resolve();

            await hold.promise;
            return text("done");
          },
        }),
      ),
    ],
    { concurrency: 1 },
  );

  try {
    const first = service.execute(request("echo", "first"));
    await firstEntered.promise;
    const second = service.execute(request("echo", "second"));
    expect(
      await Promise.race([
        secondEntered.promise.then(() => "started"),
        new Promise<string>((resolve) => setTimeout(() => resolve("queued"), 30)),
      ]),
    ).toBe("queued");
    expect(value(await service.inspect({})).running).toBe(1);
    expect(runs).toBe(1);
    hold.resolve();
    value(await first);
    value(await second);
  } finally {
    hold.resolve();
    value(await host.close());
  }
});
