import type { Context, Disposer, Plugin } from "@x-harness/core";
import { defineService } from "@x-harness/core";
import { sessionDisposed, sessionAuditEvent, sessionStore } from "@x-harness/session";
import type { SessionEvent, SessionId } from "@x-harness/session";
import { applyEvent, createFoldState, foldUsage, snapshotOf } from "./fold.ts";
import type { SessionUsage } from "./fold.ts";

export interface TokenMeterService {
  usageOf(sessionId: SessionId): SessionUsage | undefined;
  estimateText(text: string): number;
}

export const tokenMeter = defineService<TokenMeterService>("token-meter");

interface CacheEntry {
  state: ReturnType<typeof createFoldState>;
  cursor: number;
}

export const tokenMeterPlugin = {
  name: "token-meter",
  inject: ["session"],
  apply: (ctx: Context): Disposer => {
    const store = ctx.use(sessionStore);
    const cache = new Map<SessionId, CacheEntry>();

    const usageOf = (sessionId: SessionId): SessionUsage | undefined => {
      const entry = cache.get(sessionId);
      if (entry !== undefined) {
        if (entry.state.overflowed) return undefined;
        return snapshotOf(entry.state);
      }
      const session = store.get(sessionId);
      if (session === undefined) return undefined;
      const events = session.events();
      const state = foldUsage(events);
      cache.set(sessionId, { state, cursor: events.length - 1 });
      if (state.overflowed) return undefined;
      return snapshotOf(state);
    };

    const offs = [
      ctx.on(sessionAuditEvent, ({ session, event }: { session: SessionId; event: SessionEvent }) => {
        const entry = cache.get(session);
        if (entry === undefined) return;
        if (event.seq <= entry.cursor) return;
        applyEvent(entry.state, event);
        entry.cursor = event.seq;
      }),
      ctx.on(sessionDisposed, ({ session }: { session: SessionId }) => {
        cache.delete(session);
      }),
    ];

    const offProvide = ctx.provide(tokenMeter, { usageOf, estimateText });
    return () => {
      for (const off of [...offs, offProvide]) off();
      cache.clear();
    };
  },
} satisfies Plugin;

export const WIDE_TOKENS_PER_CHAR = 1.25;

const NON_PRINTABLE_RE = /[^\x20-\x7e]/g;

function countControlWhitespace(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === "\t" || ch === "\n" || ch === "\r") count += 1;
  }
  return count;
}

export function estimateText(text: string): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  const nonPrintable = text.match(NON_PRINTABLE_RE)?.length ?? 0;
  const wideCount = nonPrintable - countControlWhitespace(text);
  return Math.ceil(wideCount * WIDE_TOKENS_PER_CHAR + (text.length - wideCount) / 4);
}
