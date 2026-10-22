import { expect, it } from "vitest";
import { defineService, definePlugin } from "../../../../core/src/index";
import type { Result } from "../../../../core/src/index";
import { createToolPlugin } from "../../../tools/src/index";
import { toolScheduler } from "../index";
import type { BatchRequest, BatchReport, SchedulerError } from "../index";
import type { ToolsError } from "../../../tools/src/index";
import { world, value, text, gate, request } from "./helpers";
it("priority selects higher priority tasks but cannot starve the oldest runnable task", async () => {
  const hold = gate(),
    entered = gate();
  const order: string[] = [];
  const { host, service } = await world(
    [
      value(
        createToolPlugin({
          name: "echo",
          inputSchema: { type: "object" },
          execute: async (_i, call) => {
            order.push(call.callId);

            if (call.callId === "block") {
              entered.resolve();
              await hold.promise;
            }

            return text("x");
          },
        }),
      ),
    ],
    { concurrency: 1 },
  );

  try {
    const first = service.execute(request("echo", "block"));
    await entered.promise;
    const pending = service.batch({
      calls: [
        request("echo", "low"),
        ...Array.from({ length: 4 }, (_, i) => ({ ...request("echo", `high${i}`), priority: 10 })),
      ],
    });
    await expect.poll(async () => value(await service.inspect({})).queued).toBe(5);
    hold.resolve();
    value(await first);
    value(await pending);
    expect(order).toEqual(["block", "high0", "high1", "high2", "low", "high3"]);
  } finally {
    hold.resolve();
    value(await host.close());
  }
});
it("a saturated tool does not block a different runnable tool", async () => {
  const hold = gate(),
    entered = gate();
  const order: string[] = [];
  const { host, service } = await world(
    [
      value(
        createToolPlugin({
          name: "slow",
          inputSchema: { type: "object" },
          execute: async () => {
            entered.resolve();
            await hold.promise;
            return text("slow");
          },
        }),
      ),
      value(
        createToolPlugin({
          name: "fast",
          inputSchema: { type: "object" },
          execute: async () => {
            order.push("fast");
            return text("fast");
          },
        }),
      ),
    ],
    { concurrency: 2 },
  );

  try {
    const first = service.execute(request("slow", "first"));
    await entered.promise;
    const pending = service.batch({ calls: [request("slow", "second"), request("fast", "third")] });
    await expect.poll(() => order).toEqual(["fast"]);
    hold.resolve();
    value(await first);
    value(await pending);
  } finally {
    hold.resolve();
    value(await host.close());
  }
});
it("caller lanes rotate so a large batch cannot monopolize released slots", async () => {
  const hold = gate(),
    entered = gate();
  const order: string[] = [];
  const { host, service } = await world(
    [
      value(
        createToolPlugin({
          name: "echo",
          inputSchema: { type: "object" },
          execute: async (_i, call) => {
            order.push(call.callId);

            if (call.callId === "block") {
              entered.resolve();
              await hold.promise;
            }

            return text("x");
          },
        }),
      ),
    ],
    { concurrency: 1 },
  );
  const a = value(
      defineService<{
        run(input: BatchRequest): Promise<Result<BatchReport, SchedulerError | ToolsError>>;
      }>({ name: "caller-a", methods: { run: {} } }),
    ),
    b = value(
      defineService<{
        run(input: BatchRequest): Promise<Result<BatchReport, SchedulerError | ToolsError>>;
      }>({ name: "caller-b", methods: { run: {} } }),
    );

  try {
    value(
      await host.install([
        definePlugin({
          name: "caller-a",
          requires: { scheduler: toolScheduler },
          provides: { a },
          setup: (ctx) =>
            ctx.service({ a: { run: (input, call) => call.deps.scheduler.batch(input) } }),
        }),
        definePlugin({
          name: "caller-b",
          requires: { scheduler: toolScheduler },
          provides: { b },
          setup: (ctx) =>
            ctx.service({ b: { run: (input, call) => call.deps.scheduler.batch(input) } }),
        }),
      ]),
    );
    const first = service.execute(request("echo", "block"));
    await entered.promise;
    const pa = value(host.use(a)).run({
      calls: [request("echo", "a1"), request("echo", "a2"), request("echo", "a3")],
    });
    await expect.poll(async () => value(await service.inspect({})).queued).toBe(3);
    const pb = value(host.use(b)).run({ calls: [request("echo", "b1"), request("echo", "b2")] });
    await expect.poll(async () => value(await service.inspect({})).queued).toBe(5);
    hold.resolve();
    value(await first);
    value(await pa);
    value(await pb);
    expect(order).toEqual(["block", "a1", "b1", "a2", "b2", "a3"]);
  } finally {
    hold.resolve();
    value(await host.close());
  }
});
