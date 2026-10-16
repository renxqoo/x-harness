import { describe, expect, it, vi } from "vitest";
import { createCancellationObserver } from "../create-cancellation-observer";
import * as signals from "../../contracts/observe-signal";

describe("lifetime cancellation observation", () => {
  it("reuses one native listener while idle and removes completed callbacks", () => {
    const native = vi.spyOn(signals, "observeSignal"); const observe = createCancellationObserver(); const source = new AbortController(); const calls: string[] = [];
    try {
      const first = observe(source.signal, () => calls.push("finished")); first();
      observe(source.signal, () => calls.push("running"));
      expect(native.mock.calls.length).toBe(1); source.abort(); expect(calls).toEqual(["running"]);
    } finally { native.mockRestore(); }
  });

  it("an old release cannot remove a later subscription that reuses the same callback", () => {
    const observe = createCancellationObserver(); const source = new AbortController(); let calls = 0; const callback = () => { calls++; };
    const old = observe(source.signal, callback); old(); observe(source.signal, callback); old();
    source.abort(); expect(calls).toBe(1);
  });

  it("a failed callback or reentrant release cannot block the remaining cancellations", () => {
    const observe = createCancellationObserver(); const source = new AbortController(); const calls: string[] = [];
    let remove = () => {};
    observe(source.signal, () => { calls.push("first"); remove(); throw new Error("callback"); });
    remove = observe(source.signal, () => calls.push("removed")); observe(source.signal, () => calls.push("last"));
    expect(() => source.abort()).not.toThrow(); expect(calls).toEqual(["first", "last"]);
  });

  it("a synthetic source event starts a fresh generation that old releases cannot alter", () => {
    const observe = createCancellationObserver(); const source = new AbortController(); const calls: string[] = [];
    const old = observe(source.signal, () => calls.push("old")); source.signal.dispatchEvent(new Event("abort"));
    observe(source.signal, () => calls.push("new")); old(); source.abort(); expect(calls).toEqual(["old", "new"]);
  });

  it("already aborted sources are not given a listener that can never fire", () => {
    const native = vi.spyOn(signals, "observeSignal"); const source = new AbortController(); source.abort();
    try { const release = createCancellationObserver()(source.signal, () => {}); release(); expect(native.mock.calls.length).toBe(0); }
    finally { native.mockRestore(); }
  });
});
