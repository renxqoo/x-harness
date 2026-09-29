import type { Context, Disposer, Plugin } from "@x-harness/core";
import { contextDisposing } from "@x-harness/core";
import { createSessionStore } from "./store.ts";
import type { SessionEvent, SessionId } from "./types.ts";
import {
  sessionAuditDrain,
  sessionAuditEvent,
  sessionCreateGuard,
  sessionCreated,
  sessionDisposed,
  sessionEvent,
  sessionFlush,
  sessionStore,
} from "./tokens.ts";

interface AuditItem {
  readonly session: SessionId;
  readonly event: SessionEvent;
}

export const sessionPlugin = {
  name: "session",
  apply: (ctx: Context): Disposer => {
    let queued: AuditItem[] = [];
    let scheduled = false;
    let delivering = false;
    function deliverAudit(): void {
      if (delivering) return;
      scheduled = false;
      delivering = true;
      try {
        while (queued.length > 0) {
          const item = queued[0];
          queued = queued.slice(1);
          ctx.emit(sessionAuditEvent, item);
        }
      } finally {
        delivering = false;
      }
    }
    function scheduleAudit(): void {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(deliverAudit);
    }

    const store = createSessionStore({
      onEvent: (session, event) => {
        ctx.emit(sessionEvent, { session, event });
        queued.push({ session, event });
        scheduleAudit();
      },
      onGuard: (header) => ctx.dispatch(sessionCreateGuard, { header }),
      onCreated: (header) => {
        ctx.emit(sessionCreated, { header });
      },
      onFlush: async (session) => {
        deliverAudit();
        await ctx.dispatch(sessionFlush, { session });
      },
      onDisposed: (session) => {
        ctx.emit(sessionDisposed, { session });
      },
    });
    ctx.provide(sessionStore, store);
    ctx.provide(sessionAuditDrain, { drain: deliverAudit });
    const offDisposing = ctx.on(contextDisposing, () => {
      deliverAudit();
    });
    return () => {
      offDisposing();
      deliverAudit();
      for (const id of store.list()) store.dispose(id);
    };
  },
} satisfies Plugin;
