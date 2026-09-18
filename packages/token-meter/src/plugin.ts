// token-meter 插件（docs/TOKEN-METER.md §1）：增量（sessionEvent 监听只更新已存在条目——
// 未知会话不建账，晚装载由 usageOf 冷启动全量折叠）+ sessionDisposed 摘缓存 + 估算函数。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { defineService } from "@x-harness/core";
import { sessionDisposed, sessionEvent, sessionStore } from "@x-harness/session";
import type { SessionEvent, SessionId } from "@x-harness/session";
import { applyEvent, createFoldState, foldUsage, snapshotOf } from "./fold.ts";
import type { SessionUsage } from "./fold.ts";

export interface TokenMeterService {
  /** 未知会话 / 聚合溢出（fail-closed）→ undefined */
  usageOf(sessionId: SessionId): SessionUsage | undefined;
  /** chars/4 向上取整（UTF-16 code unit 计长）——请求压力粗估口径；非字符串降级 0 */
  estimateText(text: string): number;
}

export const tokenMeter = defineService<TokenMeterService>("token-meter");

interface CacheEntry {
  state: ReturnType<typeof createFoldState>;
  cursor: number; // 已折叠到的 seq（含）；session 单写者保证单调
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
      const state = foldUsage(session.events());
      cache.set(sessionId, { state, cursor: session.events().length - 1 }); // 溢出也缓存：usageOf 判 undefined（O(1) 短路）
      if (state.overflowed) return undefined;
      return snapshotOf(state);
    };

    const offs = [
      ctx.on(sessionEvent, ({ session, event }: { session: SessionId; event: SessionEvent }) => {
        // 晚装载纪律：未知会话不建账（建空账会钉死错误数字）——等 usageOf 冷启动
        const entry = cache.get(session);
        if (entry === undefined) return;
        if (event.seq <= entry.cursor) return; // 重放不双计（游标）
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

/** chars/4 向上取整（压缩件的请求压力预留口径） */
export function estimateText(text: string): number {
  if (typeof text !== "string") return 0;
  return Math.ceil(text.length / 4);
}
