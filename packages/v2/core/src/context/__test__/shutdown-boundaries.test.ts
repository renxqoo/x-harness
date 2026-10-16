import { afterEach, describe, expect, it } from "vitest";
import { defineChain, defineEvent, defineGuard } from "../../index";
import type { Continuation, Result, Host } from "../../index";
import { clock, deferred, flush, number, root, text, value } from "../../__test__/helpers";

const roots: Host[] = [];
afterEach(async () => { for (const item of roots.splice(0)) await item.close(); });
const setup = (options?: Parameters<typeof root>[0]) => { const item = root(options); roots.push(item); return item; };

describe("cleanup convergence and execution boundaries", () => {
  it("a parent remains tracked until a child timed-out disposer truly finishes", async () => {
    const time = clock(); const host = setup({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } });
    const child = value(host.createScope({ label: "child" })); const gate = deferred<Result<void>>();
    value(child.addCleanup(() => gate.promise));
    const closing = host.close(); await flush(); time.advance(10);
    expect((await closing).ok).toBe(false);
    expect(host.inspect()).toMatchObject({ state: "close-failed", effects: 1 });
    gate.resolve({ ok: true, value: undefined }); await flush();
    expect(host.inspect()).toMatchObject({ state: "closed", scopes: 0, effects: 0 });
    expect(time.timers.size).toBe(0);
  });
  it("a saved cleanup context is revoked after successful resource release", async () => {
    const host = setup();
    let saved!: Parameters<import("../../index").Cleanup>[0]["context"];
    const off = value(host.addCleanup((cleanup) => { saved = cleanup.context; return { ok: true, value: undefined }; }));
    value(await off());
    const token = value(defineGuard({ name: "closed-cleanup", input: text }));
    expect(saved.use(token as unknown as Parameters<typeof saved.use>[0]).ok).toBe(false);
  });
  it("pending notifications are removed when a listener is disposed before execution", async () => {
    const host = setup(); const token = value(defineEvent({ name: "queue", payload: text }));
    value(host.register(token)); let entered = 0;
    const off = value(host.on(token, () => { entered += 1; }));
    value(host.emit(token, "a"));
    value(await off());
    await flush(); expect(entered).toBe(0); expect(host.inspect().pendingEvents).toBe(0);
  });
  it("observer failures are isolated from another listener", async () => {
    const host = setup(); const token = value(defineEvent({ name: "observers", payload: text }));
    value(host.register(token)); let succeeded = 0;
    value(host.on(token, () => { throw new Error("observer failure"); }));
    value(host.on(token, () => { succeeded += 1; }));
    value(host.emit(token, "a")); await flush();
    expect(succeeded).toBe(1); expect(host.inspect().activeCalls).toBe(0);
    expect(host.diagnostics().some((diagnostic) => diagnostic.code === "callback-failed")).toBe(true);
  });
  it("an unobserved failed continuation is reported after actual settlement", async () => {
    const host = setup(); const token = value(defineChain({ name: "unobserved", input: text, output: number }));
    value(host.register(token, () => ({ ok: false, error: { source: "core", code: "callback-failed", message: "failed" } })));
    value(host.middleware(token, async (input, next) => { next(input); await flush(); return { ok: true, value: 1 }; }));
    expect(await host.dispatch(token, "a")).toMatchObject({ ok: false, error: { code: "unobserved-next" } });
  });
  it("discarded finally and rejected then branches remain tracked", async () => {
    for (const mode of ["finally", "then"] as const) {
      const host = setup(); const token = value(defineChain({ name: `branch-${mode}`, input: text, output: number }));
      value(host.register(token, () => ({ ok: false, error: { source: "core", code: "callback-failed", message: "failed" } })));
      value(host.middleware(token, async (input, next) => {
        if (mode === "finally") next(input).finally(() => {});
        else next(input).then(() => { throw new Error("derived failure"); });
        await flush(); return { ok: true, value: 1 };
      }));
      expect(await host.dispatch(token, "a")).toMatchObject({ ok: false, error: { code: "unobserved-next" } });
    }
  });
  it.each(["then", "finally"] as const)("an unfinished %s branch cannot escape its frame's actual work ledger", async (mode) => {
    const host = setup(); const gate = deferred<void>(); const token = value(defineChain({ name: `pending-${mode}`, input: text, output: number }));
    value(host.register(token, () => ({ ok: true, value: 1 })));
    value(host.middleware(token, async (input, next) => {
      const continuation = next(input); const result = await continuation;
      if (mode === "then") continuation.then(async () => { await gate.promise; return { ok: false, error: "derived failure" }; });
      else continuation.finally(async () => { await gate.promise; });
      return result;
    }));
    expect(await host.dispatch(token, "a")).toMatchObject({ ok: false, error: { code: "unfinished-next" } });
    expect(host.inspect().activeCalls).toBe(1);
    const closing = host.close(); await flush(); expect(host.inspect().activeCalls).toBe(1);
    gate.resolve(); value(await closing); expect(host.inspect().activeCalls).toBe(0);
  });
  it("branches added while a continuation is draining remain in the actual work ledger", async () => {
    const host = setup(); const a = deferred<void>(); const b = deferred<void>();
    const token = value(defineChain({ name: "draining-branches", input: text, output: number }));
    let saved!: Continuation<Result<number>>; let finished = false;
    value(host.register(token, () => ({ ok: true, value: 1 })));
    value(host.middleware(token, async (input, next) => {
      const continuation = next(input); const result = await continuation;
      saved = continuation.then(async () => { await a.promise; return result; });
      return result;
    }));
    expect(await host.dispatch(token, "a")).toMatchObject({ ok: false, error: { code: "unfinished-next" } });
    saved.then(async (result) => { await b.promise; finished = true; return result; });
    a.resolve(); await flush(); expect(host.inspect().activeCalls).toBe(1);
    const closing = host.close(); await flush(); expect(host.inspect().state).toBe("closing");
    b.resolve(); value(await closing); expect(finished).toBe(true); expect(host.inspect().activeCalls).toBe(0);
  });
  it("catch observes promise rejection separately from a failed Result", async () => {
    const host = setup(); const token = value(defineChain({ name: "catch", input: text, output: number }));
    value(host.register(token, () => ({ ok: false, error: { source: "core", code: "callback-failed", message: "failed" } })));
    let rejected = 0;
    value(host.middleware(token, async (input, next) => {
      const result = await next(input).catch(() => { rejected += 1; return { ok: true as const, value: 2 }; });
      expect(result.ok).toBe(false); return { ok: true, value: 3 };
    }));
    expect(value(await host.dispatch(token, "a"))).toBe(3); expect(rejected).toBe(0);
  });
  it("continuation limits stop additional terminal execution", async () => {
    const host = setup({ limits: { maxNextCallsPerFrame: 2 } });
    const token = value(defineChain({ name: "budget", input: text, output: number })); let calls = 0;
    value(host.register(token, () => { calls += 1; return { ok: true, value: 1 }; }));
    value(host.middleware(token, async (input, next) => { await next(input); await next(input); return await next(input); }));
    expect(await host.dispatch(token, "a")).toMatchObject({ ok: false, error: { code: "resource-limit" } });
    expect(calls).toBe(2);
  });
  it("a cancelled chain does not enter the terminal", async () => {
    const host = setup(); const token = value(defineChain({ name: "cancelled", input: text, output: number })); let calls = 0;
    value(host.register(token, () => { calls += 1; return { ok: true, value: 1 }; }));
    const controller = new AbortController(); controller.abort();
    expect(await host.dispatch(token, "a", { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(calls).toBe(0);
  });
  it("guard timeout never becomes an allow decision", async () => {
    const time = clock(); const host = setup({ scheduler: time.scheduler });
    const token = value(defineGuard({ name: "deadline-policy", input: text })); value(host.register(token));
    value(host.guard(token, () => { time.jump(11); return { ok: true, value: { kind: "allow" } }; }));
    expect(await host.dispatch(token, "a", { timeoutMs: 10 })).toMatchObject({ ok: false, error: { code: "timeout" } });
  });
  it("invalid call signal input is rejected before entering user code", async () => {
    const host = setup(); const token = value(defineChain({ name: "signal", input: text, output: number })); let calls = 0;
    value(host.register(token, () => { calls += 1; return { ok: true, value: 1 }; }));
    expect(await host.dispatch(token, "a", { signal: {} as AbortSignal })).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    expect(calls).toBe(0);
  });
});
