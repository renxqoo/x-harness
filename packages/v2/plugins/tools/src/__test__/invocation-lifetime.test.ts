import { expect, it } from "vitest";
import { createHost, definePlugin, defineService } from "../../../../core/src/index";
import type { Invocation, Result } from "../../../../core/src/index";
import { createToolPlugin, createToolsPlugin, tools } from "../index";
import { emptySchema, request, text, value } from "./helpers";
import { readContribution } from "../contributions/read-contribution";
import { runTool } from "../execution/run-tool";

it("tool preparation and execution must not freeze remaining budget at callback entry", async () => {
  let now = 0;
  const host = value(
    createHost({
      scheduler: {
        now: () => now,
        delay(callback, milliseconds) {
          const timer = setTimeout(callback, milliseconds);
          return () => clearTimeout(timer);
        },
      },
      limits: { callTimeoutMs: 1000 },
    }),
  );
  const readings: number[][] = [];
  const saved: Invocation[] = [];
  const tool = value(
    createToolPlugin({
      name: "budget",
      inputSchema: emptySchema,
      prepare(_input, call) {
        saved.push(call);
        const before = call.remainingMs;
        now += 40;
        readings.push([before, call.remainingMs]);
        return { ok: true, value: {} };
      },
      execute(_input, call) {
        saved.push(call);
        const before = call.remainingMs;
        now += 40;
        readings.push([before, call.remainingMs]);
        return text("done");
      },
    }),
  );

  try {
    value(await host.install([value(createToolsPlugin({ access: "allow" })), tool]));
    value(await value(host.use(tools)).execute(request("budget")));
    expect(readings).toEqual([
      [1000, 960],
      [960, 920],
    ]);
    expect(saved.map((call) => call.remainingMs)).toEqual([0, 0]);

    for (const call of saved) {
      expect(
        call.spawn({ label: "late", run: () => ({ ok: true, value: undefined }) }),
      ).toMatchObject({ ok: false, error: { code: "cancelled" } });
    }
  } finally {
    value(await host.close());
  }
});

it("saved tool callbacks must not revive an unconsumed service dependency", async () => {
  const host = value(createHost());
  const backend = value(
    defineService<{ read(input: string): Promise<Result<string>> }>({
      name: "tools-lazy/backend",
      methods: { read: {} },
    }),
  );
  const calls: { call: Invocation; read: () => Promise<Result<string>> }[] = [];
  let reads = 0;
  const source = definePlugin({
    name: "tools-lazy-backend",
    provides: { backend },
    setup: (ctx) =>
      ctx.service({
        backend: {
          async read(input) {
            reads++;
            return { ok: true, value: input };
          },
        },
      }),
  });
  const tool = value(
    createToolPlugin({
      name: "lazy",
      inputSchema: emptySchema,
      requires: { backend },
      prepare(_input, call) {
        calls.push({ call, read: () => call.deps.backend.read("late") });
        return { ok: true, value: {} };
      },
      execute(_input, call) {
        calls.push({ call, read: () => call.deps.backend.read("late") });
        return text("done");
      },
    }),
  );

  try {
    value(await host.install([value(createToolsPlugin({ access: "allow" })), source, tool]));
    value(await value(host.use(tools)).execute(request("lazy")));
    expect(calls).toHaveLength(2);

    for (const saved of calls) {
      expect(Object.isFrozen(saved.call)).toBe(true);
      expect(await saved.read()).toMatchObject({ ok: false, error: { code: "cancelled" } });
    }

    expect(reads).toBe(0);
  } finally {
    value(await host.close());
  }
});

it("tool runtime execution must not snapshot a managed invocation budget", async () => {
  let now = 0;
  const host = value(
    createHost({
      scheduler: {
        now: () => now,
        delay(callback, milliseconds) {
          const timer = setTimeout(callback, milliseconds);
          return () => clearTimeout(timer);
        },
      },
      limits: { callTimeoutMs: 1000 },
    }),
  );
  const owner = new AbortController();
  const entry = value(
    readContribution({
      signal: owner.signal,
      tool: { name: "runtime", concurrency: 1, inputSchema: emptySchema },
    }),
  );
  let saved: Invocation | undefined;
  const readings: number[] = [];
  let dependencyReads = 0;

  try {
    const task = value(
      host.startTask({
        label: "tool-runtime",
        run(call) {
          const observed = new Proxy(call, {
            get(target, key, receiver) {
              if (key === "deps") dependencyReads++;

              return Reflect.get(target, key, receiver) as unknown;
            },
          });
          return runTool({
            call: observed,
            limits: entry.limits,
            inputSchema: entry.compiled.input,
            outputSchema: entry.compiled.output,
            ticket: {
              entry,
              request: request("runtime"),
              caller: call.origin,
              cancel: (reason) => {
                call.cancel(reason);
              },
              plan: {
                id: "plan",
                callId: "call",
                tool: entry.tool,
                installation: entry.id,
                input: {},
                origin: call.origin,
                originId: call.originId,
                initiator: call.initiator,
                actions: {},
                resources: [],
              },
            },
            execute(_input, invocation) {
              saved = invocation;
              readings.push(invocation.remainingMs);
              now += 40;
              readings.push(invocation.remainingMs);
              return text("done");
            },
          });
        },
      }),
    );
    value(await host.wait(task));
    expect(dependencyReads).toBe(0);
    expect(readings).toEqual([1000, 960]);
    expect(saved?.remainingMs).toBe(0);
  } finally {
    owner.abort();
    value(await host.close());
  }
});
