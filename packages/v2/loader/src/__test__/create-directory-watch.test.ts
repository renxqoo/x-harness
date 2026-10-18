import { expect, it, vi } from "vitest";
import { createDirectoryWatch } from "../create-directory-watch";
import { loaderFault } from "../loader-fault";
import type { OpenDirectoryWatch, WatchCallbacks, WatchTarget } from "../watch-types";

const target = (path: string, identity = path, recursive = true): WatchTarget => ({ path, identity, recursive });
function fixture() {
  const opened: { target: WatchTarget; callbacks: WatchCallbacks; close: ReturnType<typeof vi.fn> }[] = [];
  const changed = vi.fn(), failed = vi.fn();
  const open: OpenDirectoryWatch = (value, callbacks) => { const close = vi.fn(); opened.push({ target: value, callbacks, close }); return { ok: true, value: close }; };
  return { opened, changed, failed, open };
}

it("adding a dependency retains the active root watcher without a handoff gap", () => {
  const f = fixture(), watch = createDirectoryWatch(f, f.open);
  expect(watch.sync([target("root")])).toEqual({ ok: true, value: true });
  expect(watch.sync([target("root"), target("dependency")])).toEqual({ ok: true, value: true });
  expect(f.opened.map((entry) => entry.target.path)).toEqual(["root", "dependency"]);
  expect(f.opened[0]!.close).not.toHaveBeenCalled(); f.opened[0]!.callbacks.changed(); expect(f.changed).toHaveBeenCalledOnce();
  expect(watch.sync([target("dependency"), target("root")])).toEqual({ ok: true, value: false });
  watch.close(); for (const entry of f.opened) expect(entry.close).toHaveBeenCalledOnce();
});

it("replacement identity or recursive mode reopens only that watcher and ignores its late callbacks", () => {
  const f = fixture(), watch = createDirectoryWatch(f, f.open);
  watch.sync([target("root"), target("keep")]);
  watch.sync([target("root", "replacement"), target("keep")]);
  expect(f.opened).toHaveLength(3); expect(f.opened[0]!.close).toHaveBeenCalledOnce(); expect(f.opened[1]!.close).not.toHaveBeenCalled();
  f.opened[0]!.callbacks.changed(); f.opened[0]!.callbacks.failed(); expect(f.changed).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  watch.sync([target("root", "replacement", false)]); expect(f.opened).toHaveLength(4); expect(f.opened[1]!.close).toHaveBeenCalledOnce(); expect(f.opened[2]!.close).toHaveBeenCalledOnce();
  watch.close(); watch.close(); f.opened[3]!.callbacks.changed(); f.opened[3]!.callbacks.failed();
  expect(f.changed).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled(); expect(f.opened[3]!.close).toHaveBeenCalledOnce(); expect(watch.sync([])).toMatchObject({ ok: false, error: { code: "closed" } });
});

it.each(["result", "throw"])("partial registration %s rolls back additions while retaining the previous watch set", (mode) => {
  const f = fixture(); let unavailable = false;
  const watch = createDirectoryWatch(f, (value, callbacks) => {
    if (unavailable && value.path === "missing") { if (mode === "throw") throw new Error("unavailable"); return loaderFault("watch-failed"); }
    return f.open(value, callbacks);
  });
  watch.sync([target("root")]); unavailable = true;
  expect(watch.sync([target("new"), target("missing")])).toMatchObject({ ok: false, error: { code: "watch-failed" } });
  expect(f.opened[0]!.close).not.toHaveBeenCalled(); expect(f.opened[1]!.close).toHaveBeenCalledOnce();
  f.opened[0]!.callbacks.changed(); expect(f.changed).toHaveBeenCalledOnce();
  expect(watch.sync([target("root")])).toEqual({ ok: true, value: false }); watch.close();
});

it("a watcher error retires only the failed watcher and allows it to be reattached", () => {
  const f = fixture(), watch = createDirectoryWatch(f, f.open);
  watch.sync([target("root"), target("keep")]); f.opened[0]!.callbacks.failed(); f.opened[0]!.callbacks.failed();
  expect(f.failed).toHaveBeenCalledOnce(); expect(f.opened[0]!.close).toHaveBeenCalledOnce(); expect(f.opened[1]!.close).not.toHaveBeenCalled();
  expect(watch.sync([target("root"), target("keep")])).toEqual({ ok: true, value: true }); expect(f.opened).toHaveLength(3); watch.close();
});

it("a synchronous registration error closes the returned handle and preserves the previous watcher", () => {
  const f = fixture();
  const watch = createDirectoryWatch(f, (value, callbacks) => { const result = f.open(value, callbacks); if (value.path === "bad") callbacks.failed(); return result; });
  watch.sync([target("root")]); expect(watch.sync([target("bad")])).toMatchObject({ ok: false, error: { code: "watch-failed" } });
  expect(f.opened[0]!.close).not.toHaveBeenCalled(); expect(f.opened[1]!.close).toHaveBeenCalledOnce(); watch.close();
});

it("closing during registration rolls back the returned handle", () => {
  const f = fixture(); const watch = createDirectoryWatch(f, (value, callbacks) => { const result = f.open(value, callbacks); watch.close(); return result; });
  expect(watch.sync([target("root")])).toMatchObject({ ok: false, error: { code: "closed" } }); expect(f.opened[0]!.close).toHaveBeenCalledOnce();
});

it("duplicate paths and oversized sets do not replace valid watchers", () => {
  const f = fixture(), watch = createDirectoryWatch(f, f.open); watch.sync([target("root")]);
  expect(watch.sync([target("new"), target("new")])).toMatchObject({ ok: false, error: { code: "watch-failed" } });
  expect(watch.sync(Array.from({ length: 513 }, (_, index) => target(String(index))))).toMatchObject({ ok: false, error: { code: "watch-failed" } });
  expect(f.opened).toHaveLength(2); expect(f.opened[0]!.close).not.toHaveBeenCalled(); expect(f.opened[1]!.close).toHaveBeenCalledOnce(); watch.close();
});
