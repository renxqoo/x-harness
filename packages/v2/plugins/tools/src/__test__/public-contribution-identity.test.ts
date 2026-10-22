import { expect, it } from "vitest";
import { definePlugin } from "../../../../core/src/index";
import { toolCatalog, toolPreparation, toolDispatch } from "../index";
import { deferred, emptySchema, request, text, value, world } from "./helpers";

it("fresh catalog objects keep one installation identity and cannot bypass concurrency", async () => {
  const entered = deferred(),
    finish = deferred();
  let runs = 0;
  const author = definePlugin({
    name: "ordinary-fresh",
    requires: { toolCatalog, toolPreparation, toolDispatch },
    setup(ctx) {
      const catalog = ctx.middleware("toolCatalog", (query, next) => {
        const sent = query.visit({
          signal: ctx.signal,
          tool: { name: "echo", concurrency: 1, inputSchema: emptySchema },
        });
        return sent.ok ? next(query) : sent;
      });

      if (!catalog.ok) return catalog;

      const prepare = ctx.middleware("toolPreparation", (input, next) =>
        input.ownerSignal === ctx.signal ? { ok: true, value: {} } : next(input),
      );

      if (!prepare.ok) return prepare;

      return ctx.middleware("toolDispatch", async (input, next) => {
        if (input.ownerSignal !== ctx.signal) return next(input);

        runs++;
        entered.resolve();

        if (runs === 1) await finish.promise;

        return text("done");
      });
    },
  });
  const { host, service } = await world([author]);

  try {
    const a = value(await service.prepare(request())),
      b = value(await service.prepare(request()));
    expect(a.plan.installation).toBe(b.plan.installation);
    value(await service.discard({ prepared: a }));
    value(await service.discard({ prepared: b }));
    const first = service.execute(request());
    await entered.promise;
    expect(await service.execute(request())).toMatchObject({ ok: false, error: { code: "busy" } });
    expect(runs).toBe(1);
    finish.resolve();
    expect(await first).toEqual(text("done"));
  } finally {
    finish.resolve();
    value(await host.close());
  }
});

it("conflicting fresh descriptions cannot change a tool inside the same owner lifetime", async () => {
  let concurrency = 1;
  const author = definePlugin({
    name: "ordinary",
    requires: { toolCatalog },
    setup: (ctx) =>
      ctx.middleware("toolCatalog", (query, next) => {
        const sent = query.visit({
          signal: ctx.signal,
          tool: { name: "echo", concurrency, inputSchema: emptySchema },
        });
        return sent.ok ? next(query) : sent;
      }),
  });
  const { host, service } = await world([author]);

  try {
    expect(value(await service.list({}))).toHaveLength(1);
    concurrency = 2;
    expect(await service.list({})).toMatchObject({ ok: false, error: { code: "name-conflict" } });
  } finally {
    value(await host.close());
  }
});

it("owner identity indexes bound rotating catalog names and reset after reinstall", async () => {
  let name = "tool0";
  const author = definePlugin({
    name: "ordinary",
    requires: { toolCatalog },
    setup: (ctx) =>
      ctx.middleware("toolCatalog", (query, next) => {
        const sent = query.visit({
          signal: ctx.signal,
          tool: { name, concurrency: 1, inputSchema: emptySchema },
        });
        return sent.ok ? next(query) : sent;
      }),
  });
  const { host, service } = await world();

  try {
    const installed = value(await host.install([author]));

    for (let i = 0; i < 128; i++) {
      name = `tool${i}`;
      expect(value(await service.list({}))[0]!.name).toBe(name);
    }

    name = "overflow";
    expect(await service.list({})).toMatchObject({
      ok: false,
      error: { code: "capacity-exceeded" },
    });
    value(await host.uninstall(installed.plugins[0]!));
    value(await host.install([author]));
    expect(value(await service.list({}))[0]!.name).toBe("overflow");
  } finally {
    value(await host.close());
  }
});

it("equivalent Unicode schema keys in a different order keep one contribution identity", async () => {
  let reverse = false;
  const author = definePlugin({
    name: "unicode",
    requires: { toolCatalog },
    setup: (ctx) =>
      ctx.middleware("toolCatalog", (query, next) => {
        const pairs: [[string, { type: "string" }], [string, { type: "string" }]] = [
          ["é", { type: "string" }],
          ["e\u0301", { type: "string" }],
        ];

        if (reverse) pairs.reverse();

        const sent = query.visit({
          signal: ctx.signal,
          tool: {
            name: "echo",
            concurrency: 1,
            inputSchema: { type: "object", properties: Object.fromEntries(pairs) },
          },
        });
        return sent.ok ? next(query) : sent;
      }),
  });
  const { host, service } = await world([author]);

  try {
    expect(await service.list({})).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ name: "echo" })],
    });
    reverse = true;
    expect(await service.list({})).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ name: "echo" })],
    });
  } finally {
    value(await host.close());
  }
});
