import { expect, it } from "vitest";
import { definePlugin, defineService } from "../../index";
import type { Result } from "../../index";
import { deferred, root, value } from "../../__test__/helpers";

const token = (name: string) => value(defineService<{ read(input: string): Promise<Result<string>> }>({ name, methods: { read: {} } }));

it("enumerated dependency slots remain frozen, independently cached and usable as extracted methods", async () => {
  const app = root(); const one = token("slots/one"); const two = token("slots/two"); const ctor = token("slots/constructor"); const missing = token("slots/missing"); const output = token("slots/output");
  let check = async () => {};
  try {
    value(await app.install([
      definePlugin({ name: "sources", provides: { one, two, ctor }, setup(ctx) { return ctx.service({
        one: { async read(input) { return { ok: true, value: `one:${input}` }; } },
        two: { async read(input) { return { ok: true, value: `two:${input}` }; } },
        ctor: { async read(input) { return { ok: true, value: `ctor:${input}` }; } },
      }); } }),
      definePlugin({ name: "consumer", requires: { one, two }, optional: { constructor: ctor, missing }, provides: { output }, setup(ctx) { return ctx.service({ output: { async read(input, call) {
        const before = app.inspect().serviceLeases; const deps = call.deps;
        expect(Object.keys(deps)).toEqual(["one", "two", "constructor", "missing"]); expect(deps.missing).toBeUndefined();
        expect(Object.getPrototypeOf(deps)).toBeNull(); expect(Object.isFrozen(deps)).toBe(true); expect(Reflect.set(deps, "one", null)).toBe(false);
        const first = deps.one; expect(first).toBe(deps.one); expect(Object.isFrozen(first)).toBe(true); expect(app.inspect().serviceLeases).toBe(before);
        const read = first.read; const a = value(await read(input)); const b = value(await deps.two.read(input)); const c = value(await deps.constructor!.read(input));
        expect(first).not.toBe(deps.two); expect(app.inspect().serviceLeases).toBe(before + 3);
        check = async () => {
          expect(Object.keys(deps)).toEqual(["one", "two", "constructor", "missing"]); expect(deps.missing).toBeUndefined();
          for (const source of [deps.one, deps.two, deps.constructor!]) expect(await source.read("expired")).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
        };
        return { ok: true, value: [a, b, c].join("|") };
      } } }); } }),
    ]));
    expect(value(await value(app.use(output)).read("input"))).toBe("one:input|two:input|ctor:input"); await check(); expect(app.inspect().serviceLeases).toBe(1);
  } finally { value(await app.close()); }
});

it("a dependency lease failure does not poison a later acquisition after capacity returns", async () => {
  const app = root({ limits: { maxServiceLeases: 2 } }); const one = token("slots/retry-one"); const two = token("slots/retry-two"); const output = token("slots/retry-output"); const extra = token("slots/extra");
  const attempted = deferred<void>(); const gate = deferred<void>();
  try {
    const extraInstalled = value(await app.install([definePlugin({ name: "extra", provides: { extra }, setup(ctx) { return ctx.service({ extra: { async read(input) { return { ok: true, value: input }; } } }); } })])); const occupied = value(app.use(extra));
    value(await app.install([
      definePlugin({ name: "sources", provides: { one, two }, setup(ctx) { const read = async (input: string): Promise<Result<string>> => ({ ok: true, value: input }); return ctx.service({ one: { read }, two: { read } }); } }),
      definePlugin({ name: "consumer", requires: { one, two }, provides: { output }, setup(ctx) { return ctx.service({ output: { async read(input, call) {
        const source = call.deps.one; expect(await source.read(input)).toMatchObject({ ok: false, error: { code: "resource-limit" } });
        attempted.resolve(); await gate.promise; expect(source).toBe(call.deps.one); return source.read(input);
      } } }); } }),
    ]));
    const pending = value(app.use(output)).read("retry"); await attempted.promise; value(await app.uninstall(extraInstalled.plugins[0]!));
    expect(await occupied.read("revoked")).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    gate.resolve(); expect(await pending).toEqual({ ok: true, value: "retry" }); expect(app.inspect().serviceLeases).toBe(1);
  } finally { gate.resolve(); value(await app.close()); }
});

it("saved setup dependencies distinguish acquired and untouched slots after activation ends", async () => {
  const app = root(); const one = token("slots/setup-one"); const two = token("slots/setup-two"); let check = async () => {};
  try {
    value(await app.install([
      definePlugin({ name: "sources", provides: { one, two }, setup(ctx) { const read = async (input: string): Promise<Result<string>> => ({ ok: true, value: input }); return ctx.service({ one: { read }, two: { read } }); } }),
      definePlugin({ name: "consumer", requires: { one, two }, async setup(ctx) {
        const deps = ctx.deps; expect(value(await deps.one.read("activate"))).toBe("activate");
        check = async () => {
          expect(await deps.one.read("expired")).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
          expect(Object.keys(deps.two)).toEqual(["read"]); expect(await deps.two.read("expired")).toMatchObject({ ok: false, error: { code: "cancelled" } });
        };
        return { ok: true, value: undefined };
      } }),
    ]));
    await check(); expect(app.inspect().serviceLeases).toBe(0);
  } finally { value(await app.close()); }
});
