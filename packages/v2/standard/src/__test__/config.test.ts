import { expect, it } from "vitest";
import { createHost, definePlugin } from "../../../core/src/index";
import { createFault } from "../../../core/src/validation";
import { createConfigPlugin } from "../index";
import { deferred, flush, value } from "./helpers";

const validate = (input: unknown) => typeof input === "number" && input >= 0 ? { ok: true as const, value: input } : createFault("invalid-input");

it("config validates atomically and keeps independent state for repeated plugin installations", async () => {
  const settings = value(createConfigPlugin({ name: "settings", initial: 1, validate }));
  const first = value(createHost()); const second = value(createHost());
  value(await first.install([settings.plugin])); value(await second.install([settings.plugin]));
  const read = value(first.use(settings.config)); const write = value(first.use(settings.admin));
  value(await write.update(2)); expect(value(await read.get(undefined))).toEqual({ revision: 1, value: 2 });
  expect((await write.update(-1)).ok).toBe(false); expect(value(await read.get(undefined))).toEqual({ revision: 1, value: 2 });
  expect(value(await value(second.use(settings.config)).get(undefined))).toEqual({ revision: 0, value: 1 });
  value(await first.close()); value(await second.close());
});

it("config getters receive immutable JSON and write capability remains explicitly declared", async () => {
  const settings = value(createConfigPlugin({ name: "json", initial: { enabled: true }, validate(input) { return { ok: true, value: input as { enabled: boolean } }; } }));
  const host = value(createHost()); const source = { enabled: false };
  value(await host.install([settings.plugin, definePlugin({ name: "reader", requires: { settings: settings.config }, setup(ctx) {
    expect(ctx).not.toHaveProperty("use"); return ctx.startTask({ label: "read", run: (call) => call.deps.settings.get(undefined) });
  } })]));
  const previous = value(await value(host.use(settings.config)).get(undefined));
  value(await value(host.use(settings.admin)).update(source)); source.enabled = true;
  const current = value(await value(host.use(settings.config)).get(undefined));
  expect(current.value).toEqual({ enabled: false }); expect(previous.value).toEqual({ enabled: true });
  expect(Object.isFrozen(current.value)).toBe(true); value(await host.close());
});

it("config does not commit an update when the change event cannot be accepted", async () => {
  const settings = value(createConfigPlugin({ name: "queue", initial: 0, validate })); const gate = deferred<void>();
  const host = value(createHost({ limits: { maxPendingEvents: 1 } }));
  value(await host.install([settings.plugin])); value(host.on(settings.changed, () => gate.promise));
  const write = value(host.use(settings.admin)); value(await write.update(1)); await flush();
  value(await write.update(2)); expect(await write.update(3)).toMatchObject({ ok: false, error: { code: "resource-limit" } });
  expect(value(await value(host.use(settings.config)).get(undefined))).toEqual({ revision: 2, value: 2 });
  gate.resolve(); await flush(); value(await host.close());
});

it("config rejects hostile or oversized JSON before invoking the validator", () => {
  let reads = 0; const hostile = Object.defineProperty({}, "secret", { get() { reads += 1; return 1; } });
  expect(createConfigPlugin({ name: "settings", initial: hostile, validate }).ok).toBe(false);
  expect(createConfigPlugin({ name: "settings", initial: "x".repeat(65536), validate }).ok).toBe(false);
  expect(createConfigPlugin({ name: "settings", initial: -1, validate }).ok).toBe(false);
  expect(createConfigPlugin({ name: "BAD", initial: 1, validate }).ok).toBe(false);
  expect(createConfigPlugin({ name: "settings", initial: 1, validate() { throw new Error("secret"); } })).toMatchObject({ ok: false, error: { code: "callback-failed" } });
  expect(reads).toBe(0);
});

it("config rejects malformed factories and non-JSON values returned by validators", () => {
  for (const options of [null, {}, { name: 42, initial: null, validate }, { name: "config", initial: null, validate: 42 }, { name: "config", initial: 1, validate, extra: true }]) {
    expect(createConfigPlugin(options as Parameters<typeof createConfigPlugin>[0]).ok).toBe(false);
  }
  const unsafe = createConfigPlugin({ name: "unsafe", initial: null, validate: () => ({ ok: true, value: new Map() as unknown as import("../../../core/src/index").JsonValue }) });
  expect(unsafe).toMatchObject({ ok: false, error: { code: "invalid-result" } });
});
