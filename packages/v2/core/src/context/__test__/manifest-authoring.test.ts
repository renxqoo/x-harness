import { expect, it } from "vitest";
import { defineEvent, definePlugin, defineService } from "../../index";
import type { EmitReceipt, PluginContext, PluginImplementations, PluginInvocation, PluginResource, PluginTask, Result, TaskHandle } from "../../index";
import { flush, root, value } from "../../__test__/helpers";

it("extracted author helpers share one declaration across services, resources, tasks and events", async () => {
  const app = root();
  const source = value(defineService<{ read(input: string): Promise<Result<string>> }>({ name: "manifest/source", methods: { read: {} } }));
  const target = value(defineService<{ read(input: string): Promise<Result<string>> }>({ name: "manifest/target", methods: { read: {} } }));
  const optional = value(defineService<{ read(input: string): Promise<Result<string>> }>({ name: "manifest/optional", methods: { read: {} } }));
  const changed = value(defineEvent<string>({ name: "manifest/changed", payload: (input) => typeof input === "string" ? { ok: true, value: input } : { ok: false, error: { source: "core", code: "invalid-input", message: "text" } } }));
  const manifest = { name: "consumer", requires: { source, changed }, provides: { target }, optional: { optional } };
  let releases = 0; let publish!: (input: string) => Result<EmitReceipt>; let started!: TaskHandle<string>;
  const received: string[] = [];
  function read(call: PluginInvocation<typeof manifest>, input: string) {
    return call.deps.optional ? call.deps.optional.read(input) : call.deps.source.read(input);
  }
  const resource: PluginResource<string, never, typeof manifest> = {
    open: (call) => read(call, "open"),
    close: () => { releases++; return { ok: true, value: undefined }; },
  };
  const task: PluginTask<string, never, typeof manifest> = { label: "refresh", run: (call) => read(call, "task") };
  function createImplementations(connection: string): PluginImplementations<typeof manifest> {
    return { target: { async read(input, call) { return read(call, `${connection}:${input}`); } } };
  }
  async function setup(ctx: PluginContext<typeof manifest>) {
    const opened = await ctx.resource(resource); if (!opened.ok) return opened;
    const listening = ctx.on("changed", async (input, _origin, call) => { received.push(value(await read(call, input))); }); if (!listening.ok) return listening;
    const running = ctx.startTask(task); if (!running.ok) return running; started = running.value;
    return ctx.service(createImplementations(opened.value));
  }
  value(await app.install([
    definePlugin({ name: "source", provides: { source, changed }, setup(ctx) {
      publish = (input) => ctx.emit("changed", input);
      return ctx.service({ source: { async read(input) { return { ok: true, value: input }; } } });
    } }),
    definePlugin({ ...manifest, setup }),
  ]));
  expect(value(await value(app.use(target)).read("input"))).toBe("open:input");
  expect(value(await started.finished)).toBe("task"); value(publish("event")); await flush(); expect(received).toEqual(["event"]);
  expect(releases).toBe(0); value(await app.close()); expect(releases).toBe(1);
  expect(app.inspect()).toMatchObject({ activeCalls: 0, activeTasks: 0, serviceLeases: 0, effects: 0, resources: [] });
});
