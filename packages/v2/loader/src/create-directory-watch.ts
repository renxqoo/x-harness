import type { WatchCallbacks, WatchTarget, OpenDirectoryWatch } from "./watch-types";
import { openDirectoryWatch } from "./open-directory-watch";
import { loaderFault } from "./loader-fault";
interface Entry { readonly target: WatchTarget; active: boolean; close?: () => void }
interface State { readonly entries: Map<string, Entry>; readonly callbacks: WatchCallbacks; readonly open: OpenDirectoryWatch }
const closeEntry = (entry: Entry) => { entry.active = false; const close = entry.close; entry.close = undefined; close?.(); };
export function createDirectoryWatch(callbacks: WatchCallbacks, open: OpenDirectoryWatch = openDirectoryWatch) {
  const cell: { current?: State } = { current: { entries: new Map(), callbacks, open } };
  return {
    sync(targets: readonly WatchTarget[]) {
      const state = cell.current; if (!state) return loaderFault("closed");
      const added: Entry[] = [], next = new Map<string, Entry>(), ref = new WeakRef(state);
      const rollback = () => { for (const entry of added) closeEntry(entry); };
      try {
        if (targets.length > 512) return loaderFault("watch-failed");
        for (const target of targets) {
          if (next.has(target.path)) { rollback(); return loaderFault("watch-failed"); }
          const previous = state.entries.get(target.path);
          if (previous?.active && previous.target.identity === target.identity && previous.target.recursive === target.recursive) { next.set(target.path, previous); continue; }
          const entry: Entry = { target: Object.freeze({ ...target }), active: true }; added.push(entry);
          const opened = state.open(entry.target, {
            changed() { const owner = ref.deref(); if (entry.active && owner) owner.callbacks.changed(); },
            failed() {
              const owner = ref.deref(); if (!entry.active || !owner) return;
              closeEntry(entry); if (owner.entries.get(entry.target.path) === entry) owner.entries.delete(entry.target.path);
              owner.callbacks.failed();
            },
          });
          if (!opened.ok) { rollback(); return opened; }
          entry.close = opened.value;
          if (!entry.active || cell.current !== state) { rollback(); return loaderFault(cell.current ? "watch-failed" : "closed"); }
          next.set(target.path, entry);
        }
        const changed = added.length > 0 || next.size !== state.entries.size;
        const obsolete = [...state.entries].filter(([path, entry]) => next.get(path) !== entry).map(([, entry]) => entry);
        state.entries.clear(); for (const [path, entry] of next) state.entries.set(path, entry);
        for (const entry of obsolete) closeEntry(entry);
        return { ok: true as const, value: changed };
      } catch { rollback(); return loaderFault("watch-failed"); }
    },
    close() {
      const state = cell.current; cell.current = undefined;
      if (state) { for (const entry of state.entries.values()) closeEntry(entry); state.entries.clear(); }
    },
  };
}
