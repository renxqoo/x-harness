import { expect, it } from "vitest";
import { definePlugin } from "../../../../core/src/index";
import { createToolPlugin, toolAccess } from "../../../tools/src/index";
import { toolScheduleAccess } from "../index";
import { world, value, text, gate, request } from "./helpers";
it("required admission without a policy never executes an author", async () => {
  let runs = 0;
  const { host, service } = await world(
    [
      value(
        createToolPlugin({
          name: "echo",
          inputSchema: { type: "object" },
          execute: async () => {
            runs++;
            return text("x");
          },
        }),
      ),
    ],
    {},
    "required",
  );

  try {
    expect(await service.execute(request())).toMatchObject({
      ok: false,
      error: { source: "tool-scheduler", code: "access-denied" },
    });
    expect(runs).toBe(0);
    expect(value(await service.inspect({}))).toEqual({ running: 0, queued: 0, requests: 0 });
  } finally {
    value(await host.close());
  }
});
it("a denying policy wins over explicit allow and uses the real submitting origin", async () => {
  let origin: unknown;
  const deny = definePlugin({
    name: "deny",
    requires: { access: toolScheduleAccess },
    setup: (ctx) =>
      ctx.guard("access", (input) => {
        origin = input.origin;
        return { ok: true, value: { kind: "deny", reason: "policy" } };
      }),
  });
  const { host, service } = await world([deny]);

  try {
    expect(await service.execute(request())).toMatchObject({
      ok: false,
      error: { code: "access-denied" },
    });
    expect(origin).toEqual({ scopeId: "root" });
  } finally {
    value(await host.close());
  }
});
it("permission revoked while queued is rechecked before the author starts", async () => {
  const hold = gate(),
    entered = gate();
  let revoked = false;
  const runs: string[] = [];
  const policy = definePlugin({
    name: "revoke",
    requires: { access: toolScheduleAccess },
    setup: (ctx) =>
      ctx.guard("access", (input) => ({
        ok: true,
        value:
          input.calls[0]!.callId === "block" || !revoked
            ? { kind: "allow" }
            : { kind: "deny", reason: "revoked" },
      })),
  });
  const { host, service } = await world(
    [
      policy,
      value(
        createToolPlugin({
          name: "echo",
          inputSchema: { type: "object" },
          execute: async (_i, call) => {
            runs.push(call.callId);
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
    const first = service.execute(request("echo", "block"));
    await entered.promise;
    const second = service.execute(request("echo", "queued"));
    await expect.poll(async () => value(await service.inspect({})).queued).toBe(1);
    revoked = true;
    hold.resolve();
    value(await first);
    expect(await second).toMatchObject({ ok: false, error: { code: "access-denied" } });
    expect(runs).toEqual(["block"]);
  } finally {
    hold.resolve();
    value(await host.close());
  }
});
it("tools authorization sees the scheduler delegation rather than a forged submitter", async () => {
  const origins: unknown[] = [];
  const policy = definePlugin({
    name: "observe",
    requires: { access: toolAccess },
    setup: (ctx) =>
      ctx.guard("access", (input) => {
        origins.push(input.origin);
        return { ok: true, value: { kind: "allow" } };
      }),
  });
  const { host, service } = await world([
    policy,
    value(
      createToolPlugin({
        name: "echo",
        inputSchema: { type: "object" },
        execute: async () => text("x"),
      }),
    ),
  ]);

  try {
    value(await service.execute(request()));
    expect(origins.length).toBeGreaterThan(1);
    expect(
      origins.every(
        (origin) => (origin as { pluginName?: string }).pluginName === "tool-scheduler",
      ),
    ).toBe(true);
    expect(
      await service.execute({ ...request(), origin: { scopeId: "fake" } } as never),
    ).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  } finally {
    value(await host.close());
  }
});
it("tool metadata is read once per name within a batch and refreshed for the next request", async () => {
  let reads = 0;
  const policy = definePlugin({
    name: "metadata",
    requires: { access: toolAccess },
    setup: (ctx) =>
      ctx.guard("access", (input) => {
        if (input.operation === "get") reads++;

        return { ok: true, value: { kind: "allow" } };
      }),
  });
  const { host, service } = await world([
    policy,
    value(
      createToolPlugin({
        name: "echo",
        concurrency: 2,
        inputSchema: { type: "object" },
        execute: async () => text("x"),
      }),
    ),
  ]);

  try {
    value(await service.batch({ calls: [request("echo", "a"), request("echo", "b")] }));
    expect(reads).toBe(1);
    value(await service.execute(request()));
    expect(reads).toBe(2);
  } finally {
    value(await host.close());
  }
});
