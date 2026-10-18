import { afterEach, expect, it, vi } from "vitest";
import { createDirectoryWatch } from "../create-directory-watch";
import { createRefresh } from "../create-refresh";
import { loaderFault } from "../loader-fault";
import type { Result } from "../../../core/src/index";
import type { ApplicationSnapshot } from "../../../application/src/index";
import type { LoaderFault } from "../types";

type Outcome = Result<ApplicationSnapshot, LoaderFault>;
const success: Outcome = { ok: true, value: { state: "open", plugins: [] } };
afterEach(() => { vi.useRealTimers(); });
function fixture(watch = true, debounceMs = 5) {
  vi.useFakeTimers(); let outcome: Outcome = loaderFault("build-failed"); let blocked: "closed" | "restart-required" | undefined;
  const run = vi.fn(async () => outcome);
  const refresh = createRefresh({ run, watch, debounceMs, blocked: () => blocked });
  return { refresh, run, set(value: Outcome) { outcome = value; }, block(value: typeof blocked) { blocked = value; } };
}

it("a repaired build recovers without receiving another filesystem event", async () => {
  const f = fixture(); expect(await f.refresh.reload()).toMatchObject({ ok: false, error: { code: "build-failed" } });
  f.set(success); await vi.advanceTimersByTimeAsync(99); expect(f.run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(f.run).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10000); expect(f.run).toHaveBeenCalledTimes(2); await f.refresh.close();
});

it.each(["build-failed", "watch-failed"] as const)("%s retries use one capped backoff timer and reset after success", async (code) => {
  const f = fixture(); f.set(loaderFault(code)); await f.refresh.reload(); let count = 1;
  for (const delay of [100, 200, 400, 800, 1000, 1000]) {
    expect(vi.getTimerCount()).toBe(1); await vi.advanceTimersByTimeAsync(delay - 1); expect(f.run).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(1); count += 1; expect(f.run).toHaveBeenCalledTimes(count);
  }
  f.set(success); await vi.advanceTimersByTimeAsync(1000); expect(vi.getTimerCount()).toBe(0);
  f.set(loaderFault(code)); await f.refresh.reload(); await vi.advanceTimersByTimeAsync(99); expect(f.run).toHaveBeenCalledTimes(count + 2);
  await vi.advanceTimersByTimeAsync(1); expect(f.run).toHaveBeenCalledTimes(count + 3); await f.refresh.close(); expect(vi.getTimerCount()).toBe(0);
});

it("filesystem changes preempt a pending recovery timer and coalesce into one debounce", async () => {
  const f = fixture(); await f.refresh.reload(); f.set(success);
  f.refresh.changed(); f.refresh.changed(); f.refresh.changed(); expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(4); expect(f.run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(f.run).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0); await f.refresh.close();
});

it("retries respect a debounce longer than the capped backoff", async () => {
  const f = fixture(true, 2000); await f.refresh.reload(); f.set(success);
  await vi.advanceTimersByTimeAsync(1999); expect(f.run).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(1); expect(f.run).toHaveBeenCalledTimes(2); await f.refresh.close();
});

it.each(["import-failed", "invalid-plugin", "restart-required", "closed"] as const)("%s does not retry side effects automatically", async (code) => {
  const f = fixture(); f.set(loaderFault(code)); await f.refresh.reload(); expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10000); expect(f.run).toHaveBeenCalledOnce(); await f.refresh.close();
});

it("activation faults and watch-disabled builds do not arm recovery timers", async () => {
  const f = fixture(); f.set({ ok: false, error: { source: "core", code: "activation-failed", message: "failed" } }); await f.refresh.reload(); expect(vi.getTimerCount()).toBe(0); await f.refresh.close();
  const manual = fixture(false); await manual.refresh.reload(); expect(vi.getTimerCount()).toBe(0); await manual.refresh.close();
});

it("concurrent reloads share a promise and serialize a trailing refresh", async () => {
  vi.useFakeTimers(); let release: (value: Outcome) => void = () => {};
  const run = vi.fn(() => new Promise<Outcome>((resolve) => { release = resolve; }));
  const refresh = createRefresh({ run, watch: true, debounceMs: 5, blocked: () => undefined });
  const first = refresh.reload(); await Promise.resolve(); expect(refresh.reload()).toBe(first); refresh.changed(); refresh.changed(); expect(run).toHaveBeenCalledOnce();
  release(success); await Promise.resolve(); expect(run).toHaveBeenCalledTimes(2);
  release(success); expect(await first).toEqual(success); expect(vi.getTimerCount()).toBe(0); await refresh.close();
});

it("an event queued between the last build and completion is not lost", async () => {
  vi.useFakeTimers(); let count = 0;
  const refresh = createRefresh({ watch: true, debounceMs: 5, blocked: () => undefined,
    async run() { count += 1; if (count === 1) queueMicrotask(() => queueMicrotask(() => refresh.changed())); return success; },
  });
  await refresh.reload(); await vi.advanceTimersByTimeAsync(5); expect(count).toBe(2); expect(vi.getTimerCount()).toBe(0); await refresh.close();
});

it("close cancels recovery and ignores late changes", async () => {
  const f = fixture(); await f.refresh.reload(); await f.refresh.close(); await f.refresh.close(); f.refresh.changed();
  expect(await f.refresh.reload()).toMatchObject({ ok: false, error: { code: "closed" } }); expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10000); expect(f.run).toHaveBeenCalledOnce();
});

it("close waits for an in-flight build without starting its dirty follow-up", async () => {
  vi.useFakeTimers(); let release: (value: Outcome) => void = () => {};
  const run = vi.fn(() => new Promise<Outcome>((resolve) => { release = resolve; }));
  const refresh = createRefresh({ run, watch: true, debounceMs: 5, blocked: () => undefined });
  const pending = refresh.reload(); await Promise.resolve(); refresh.changed(); let finished = false; const closing = refresh.close().then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false); release(loaderFault("build-failed")); await pending; await closing;
  expect(finished).toBe(true); expect(run).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it("a restart requirement prevents pending timers and late changes from rebuilding", async () => {
  const f = fixture(); await f.refresh.reload(); f.block("restart-required"); f.refresh.changed();
  await vi.advanceTimersByTimeAsync(1000); expect(f.run).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  expect(await f.refresh.reload()).toMatchObject({ ok: false, error: { code: "restart-required" } }); await f.refresh.close();
});

it("unexpected run rejection returns a terminal failure instead of retrying possible side effects", async () => {
  vi.useFakeTimers(); const run = vi.fn(async (): Promise<Outcome> => { throw new Error("unexpected"); });
  const refresh = createRefresh({ run, watch: true, debounceMs: 0, blocked: () => undefined });
  expect(await refresh.reload()).toMatchObject({ ok: false, error: { code: "restart-required" } }); expect(vi.getTimerCount()).toBe(0); await refresh.close();
});

it("persistent synchronous watcher errors obey backoff instead of immediately spinning", async () => {
  vi.useFakeTimers(); let opens = 0, closes = 0, changed = false;
  const watch = createDirectoryWatch({ changed() { refresh.changed(); }, failed() { refresh.failed(); } }, (_target, callbacks) => {
    opens += 1; callbacks.failed(); return { ok: true, value() { closes += 1; } };
  });
  const refresh = createRefresh({ watch: true, debounceMs: 5, blocked: () => opens >= 20 ? "restart-required" : undefined, async run() {
    const result = watch.sync([{ path: "root", identity: "1:2", recursive: true }]); if (result.ok) changed = result.value;
    return result.ok ? success : result;
  } });
  expect(await refresh.reload()).toMatchObject({ ok: false, error: { code: "watch-failed" } }); expect(opens).toBe(1); expect(closes).toBe(1); expect(changed).toBe(false);
  for (const [index, delay] of [100, 200, 400, 800, 1000, 1000].entries()) {
    expect(vi.getTimerCount()).toBe(1); await vi.advanceTimersByTimeAsync(delay - 1); expect(opens).toBe(index + 1);
    await vi.advanceTimersByTimeAsync(1); expect(opens).toBe(index + 2); expect(closes).toBe(opens);
  }
  await refresh.close(); watch.close(); expect(vi.getTimerCount()).toBe(0);
});

it("watcher errors arriving during an otherwise successful refresh are retried after completion", async () => {
  vi.useFakeTimers(); const run = vi.fn(async () => { if (run.mock.calls.length === 1) refresh.failed(); return success; });
  const refresh = createRefresh({ run, watch: true, debounceMs: 5, blocked: () => undefined });
  await refresh.reload(); expect(run).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(99); expect(run).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0); await refresh.close();
});

it("idle watch errors coalesce into one recovery timer and are ignored after close", async () => {
  const f = fixture(); f.set(success); await f.refresh.reload(); f.refresh.failed(); f.refresh.failed(); expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(99); expect(f.run).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(1); expect(f.run).toHaveBeenCalledTimes(2);
  await f.refresh.close(); f.refresh.failed(); expect(vi.getTimerCount()).toBe(0);
  const manual = fixture(false); manual.refresh.failed(); expect(vi.getTimerCount()).toBe(0); await manual.refresh.close();
});

it.each(["import-failed", "invalid-plugin"] as const)("watch errors during %s do not retry module side effects", async (code) => {
  vi.useFakeTimers(); const run = vi.fn(async () => { refresh.failed(); return loaderFault(code); });
  const refresh = createRefresh({ run, watch: true, debounceMs: 5, blocked: () => undefined });
  await refresh.reload(); expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(10000); expect(run).toHaveBeenCalledOnce(); await refresh.close();
});

it("idle watcher errors after an import failure wait for an explicit file change before retrying", async () => {
  const f = fixture(); f.set(loaderFault("import-failed")); await f.refresh.reload(); f.refresh.failed(); f.refresh.failed();
  expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(10000); expect(f.run).toHaveBeenCalledOnce();
  f.set(success); f.refresh.changed(); await vi.advanceTimersByTimeAsync(5); expect(f.run).toHaveBeenCalledTimes(2); f.refresh.failed(); await vi.advanceTimersByTimeAsync(100); expect(f.run).toHaveBeenCalledTimes(3); await f.refresh.close();
});

it("closing before a scheduled refresh starts prevents the run from acquiring resources", async () => {
  const f = fixture(); const pending = f.refresh.reload(); await f.refresh.close();
  expect(await pending).toMatchObject({ ok: false, error: { code: "closed" } }); expect(f.run).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it("topology revalidation follows a successful refresh without replaying a failed import", async () => {
  vi.useFakeTimers(); let outcome: Outcome = success;
  const run = vi.fn(async () => { if (run.mock.calls.length === 1 || run.mock.calls.length === 3) refresh.revalidate(); return outcome; });
  const refresh = createRefresh({ run, watch: true, debounceMs: 5, blocked: () => undefined });
  await refresh.reload(); expect(run).toHaveBeenCalledTimes(2); outcome = loaderFault("import-failed");
  expect(await refresh.reload()).toMatchObject({ ok: false, error: { code: "import-failed" } }); expect(run).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
  await refresh.close(); refresh.revalidate(); expect(vi.getTimerCount()).toBe(0);
});

it("idle topology revalidation is coalesced and blocked after restart", async () => {
  const f = fixture(); f.set(success); f.refresh.revalidate(); f.refresh.revalidate(); expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(5); expect(f.run).toHaveBeenCalledOnce(); f.block("restart-required"); f.refresh.revalidate(); expect(vi.getTimerCount()).toBe(0); await f.refresh.close();
});
