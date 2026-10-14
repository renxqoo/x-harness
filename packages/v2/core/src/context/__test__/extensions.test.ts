import { afterEach, describe, expect, it } from "vitest";
import { defineChain, defineEvent, defineGuard } from "../../index";
import type { Continuation, GuardHandler, Invocation, Result, RootContext } from "../../index";
import { clock, deferred, flush, number, root, text, value } from "../../__test__/helpers";

const roots: RootContext[] = [];
afterEach(async () => { for (const item of roots.splice(0)) await item.dispose(); });
const setup = (options?: Parameters<typeof root>[0]) => { const item = root(options); roots.push(item); return item; };
const chain = () => value(defineChain<string, number>({ name: "execute", input: text, output: number }));
const guard = () => value(defineGuard({ name: "policy", input: text }));
const event = () => value(defineEvent({ name: "notice", payload: text }));

describe("chain and guard execution", () => {
  it("wraps in deterministic order and permits a validated short circuit", async () => {
    const host = setup();
    const token = chain();
    const order: string[] = [];
    value(host.provide(token, (input) => { order.push(input); return { ok: true, value: 1 }; }));
    value(host.on(token, async (input, next) => { order.push("outer"); const result = await next(input); order.push("done"); return result; }));
    value(host.on(token, (input, next) => { order.push("inner"); return next(input); }));
    expect(value(await host.dispatch(token, "terminal"))).toBe(1);
    expect(order).toEqual(["outer", "inner", "terminal", "done"]);
    const second = setup();
    value(second.provide(token, () => { throw new Error("must not enter"); }));
    value(second.on(token, () => ({ ok: true, value: 9 })));
    expect(value(await second.dispatch(token, "short"))).toBe(9);
  });
  it("serial next retries revalidate and invoke the terminal independently", async () => {
    const host = setup();
    const token = chain();
    const ids: string[] = [];
    let calls = 0;
    value(host.provide(token, (_input, call) => {
      ids.push(call.id); calls += 1;
      if (calls === 1) return { ok: false, reason: { source: "core", code: "callback-failed", message: "callback-failed" } };
      return { ok: true, value: 7 };
    }));
    value(host.on(token, async (input, next) => {
      const first = await next(input);
      if (first.ok) return first;
      return await next(input);
    }));
    expect(value(await host.dispatch(token, "retry"))).toBe(7);
    expect(new Set(ids).size).toBe(2);
  });
  it("concurrent next does not execute a second terminal", async () => {
    const host = setup();
    const token = chain();
    const delayed = deferred<Result<number>>();
    let calls = 0;
    let second: Result<number> | undefined;
    value(host.provide(token, () => { calls += 1; return delayed.promise; }));
    value(host.on(token, async (input, next) => {
      const first = next(input);
      second = await next(input);
      return await first;
    }));
    const pending = host.dispatch(token, "a");
    await flush();
    expect(second).toMatchObject({ ok: false, reason: { code: "concurrent-next" } });
    expect(calls).toBe(1);
    delayed.resolve({ ok: true, value: 1 });
    expect(value(await pending)).toBe(1);
  });
  it("next saved beyond a returned handler fails as late-next", async () => {
    const host = setup();
    const token = chain();
    let saved!: (input: string) => Continuation<Result<number>>;
    value(host.provide(token, () => ({ ok: true, value: 1 })));
    value(host.on(token, (_input, next) => { saved = next; return { ok: true, value: 2 }; }));
    expect(value(await host.dispatch(token, "a"))).toBe(2);
    expect(await saved("a")).toMatchObject({ ok: false, reason: { code: "late-next" } });
  });
  it("unobserved and unfinished next is rejected and its real work is drained", async () => {
    const host = setup();
    const token = chain();
    const delayed = deferred<Result<number>>();
    value(host.provide(token, () => delayed.promise));
    value(host.on(token, (input, next) => { next(input); return { ok: true, value: 3 }; }));
    const pending = host.dispatch(token, "a");
    await flush();
    expect(host.inspect().activeCalls).toBeGreaterThan(0);
    delayed.resolve({ ok: true, value: 1 });
    expect(await pending).toMatchObject({ ok: false, reason: { code: "unfinished-next" } });
  });
  it("a handler revoked after plan capture is not silently skipped", async () => {
    const host = setup();
    const token = chain();
    const gate = deferred<void>();
    value(host.provide(token, () => ({ ok: true, value: 1 })));
    value(host.on(token, async (input, next) => { await gate.promise; return await next(input); }));
    const off = value(host.on(token, (input, next) => next(input)));
    const pending = host.dispatch(token, "a");
    await flush();
    value(await off({ context: host, signal: new AbortController().signal, deadline: Infinity }));
    gate.resolve();
    expect(await pending).toMatchObject({ ok: false, reason: { code: "extension-revoked" } });
  });
  it("online install affects later plans and unloading restores the next plan", async () => {
    const host = setup();
    const token = chain();
    value(host.provide(token, () => ({ ok: true, value: 1 })));
    expect(value(await host.dispatch(token, "a"))).toBe(1);
    const installed = value(await host.load([{ name: "extension", requires: [token], apply(ctx) {
      return ctx.on(token, async (input, next) => { const result = await next(input); if (!result.ok) return result; return { ok: true, value: result.value + 10 }; });
    } }]));
    expect(value(await host.dispatch(token, "a"))).toBe(11);
    value(await host.unload(installed.plugins[0]!));
    expect(value(await host.dispatch(token, "a"))).toBe(1);
  });
  it("invalid chain input never enters the handler and invalid output cannot succeed", async () => {
    const host = setup();
    const token = chain();
    let calls = 0;
    value(host.provide(token, () => { calls += 1; return { ok: true, value: "wrong" as unknown as number }; }));
    expect((await host.dispatch(token, 1 as unknown as string)).ok).toBe(false);
    expect(calls).toBe(0);
    expect(await host.dispatch(token, "a")).toMatchObject({ ok: false, reason: { code: "invalid-result" } });
  });
  it("guard requires explicit decisions and stops at the first denial", async () => {
    const host = setup();
    const token = guard();
    value(host.provide(token));
    expect(await host.dispatch(token, "a")).toMatchObject({ ok: false, reason: { code: "guard-unconfigured" } });
    let after = 0;
    value(host.on(token, () => ({ ok: true, value: { kind: "allow" as const } })));
    value(host.on(token, () => ({ ok: true, value: { kind: "deny" as const, reason: "blocked" } })));
    value(host.on(token, () => { after += 1; return { ok: true, value: { kind: "allow" as const } }; }));
    expect(value(await host.dispatch(token, "a"))).toEqual({ kind: "deny", reason: "blocked" });
    expect(after).toBe(0);
  });
  it("a thrown guard and an invalid guard result cannot allow execution", async () => {
    for (const implementation of [() => { throw new Error("secret"); }, () => undefined]) {
      const host = setup();
      const token = guard();
      value(host.provide(token));
      value(host.on(token, implementation as unknown as GuardHandler<string>));
      expect((await host.dispatch(token, "a")).ok).toBe(false);
      expect(JSON.stringify(host.diagnostics())).not.toContain("secret");
    }
  });
  it("provider invocation contains its source, executor and cancellation signal", async () => {
    const host = setup();
    const token = chain();
    let call!: Invocation;
    value(host.provide(token, (_input, invocation) => { call = invocation; return { ok: true, value: 1 }; }));
    value(await host.dispatch(token, "a"));
    expect(call.origin.scopeId).toBe("root");
    expect(call.executor.scopeId).toBe("root");
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("bounded notification delivery", () => {
  it("serializes each listener while another listener continues independently", async () => {
    const host = setup();
    const token = event();
    value(host.provide(token));
    const gate = deferred<void>();
    const slow: string[] = [];
    const fast: string[] = [];
    value(host.on(token, async (input) => { slow.push(input); if (input === "one") await gate.promise; }));
    value(host.on(token, (input) => { fast.push(input); }));
    value(host.emit(token, "one"));
    value(host.emit(token, "two"));
    await flush();
    expect(slow).toEqual(["one"]);
    expect(fast).toEqual(["one", "two"]);
    gate.resolve();
    await flush();
    expect(slow).toEqual(["one", "two"]);
  });
  it("event payload is a stable shared immutable snapshot", async () => {
    const host = setup();
    const token = value(defineEvent<{ item: string }>({ name: "objects", payload: (input) => ({ ok: true, value: input as { item: string } }) }));
    value(host.provide(token));
    const received: string[] = [];
    value(host.on(token, (input) => { expect(Object.isFrozen(input)).toBe(true); received.push(input.item); }));
    const input = { item: "before" };
    value(host.emit(token, input));
    input.item = "after";
    await flush();
    expect(received).toEqual(["before"]);
  });
  it("capacity rejection is atomic across all listeners", async () => {
    const host = setup({ limits: { maxPendingEvents: 1 } });
    const token = event();
    value(host.provide(token));
    let calls = 0;
    value(host.on(token, () => { calls += 1; }));
    value(host.on(token, () => { calls += 1; }));
    expect(host.emit(token, "a")).toMatchObject({ ok: false, reason: { code: "resource-limit" } });
    await flush();
    expect(calls).toBe(0);
  });
  it("observer timeout cancels its pending queue without overlapping real execution", async () => {
    const time = clock();
    const host = setup({ scheduler: time.scheduler, limits: { observerTimeoutMs: 10 } });
    const token = event();
    value(host.provide(token));
    const gate = deferred<void>();
    const received: string[] = [];
    value(host.on(token, async (input) => { received.push(input); await gate.promise; }));
    value(host.emit(token, "one"));
    value(host.emit(token, "two"));
    await flush();
    time.advance(10);
    await flush();
    expect(host.inspect()).toMatchObject({ activeCalls: 1, pendingEvents: 0 });
    gate.resolve();
    await flush();
    expect(received).toEqual(["one"]);
    value(await host.dispose());
    expect(time.timers.size).toBe(0);
  });
  it("child notifications reach ancestors but never sibling listeners", async () => {
    const host = setup();
    const token = event();
    value(host.provide(token));
    const child = value(host.scope({ label: "child" }));
    const sibling = value(host.scope({ label: "sibling" }));
    const calls: string[] = [];
    value(host.on(token, () => { calls.push("root"); }));
    value(child.on(token, () => { calls.push("child"); }));
    value(sibling.on(token, () => { calls.push("sibling"); }));
    value(child.emit(token, "a"));
    await flush();
    expect(calls).toEqual(["root", "child"]);
  });
  it.each([Infinity, () => {}, Symbol("bad"), new Date()])("rejects non-JSON notification data: %s", (input) => {
    const host = setup();
    const token = value(defineEvent<unknown>({ name: "json", payload: (raw) => ({ ok: true, value: raw }) }));
    value(host.provide(token));
    expect(host.emit(token, input).ok).toBe(false);
  });
  it("accessor payloads are rejected without running a getter", () => {
    const host = setup();
    const token = value(defineEvent<unknown>({ name: "accessor", payload: (raw) => ({ ok: true, value: raw }) }));
    value(host.provide(token));
    let called = 0;
    const payload = { get value() { called += 1; return "secret"; } };
    expect(host.emit(token, payload).ok).toBe(false);
    expect(called).toBe(0);
  });
  it("cyclic and oversized payloads are rejected while no-listener delivery is explicit", () => {
    const host = setup({ limits: { maxEventBytes: 10 } });
    const token = event();
    value(host.provide(token));
    expect(host.emit(token, "x".repeat(100))).toMatchObject({ ok: false, reason: { code: "resource-limit" } });
    expect(value(host.emit(token, "ok")).acceptedListeners).toBe(0);
    const any = value(defineEvent<unknown>({ name: "cycle", payload: (raw) => ({ ok: true, value: raw }) }));
    value(host.provide(any));
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    expect(host.emit(any, cycle).ok).toBe(false);
  });
});
