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
  /** 上界口径 token 估算（ASCII/空白 len/4、非 ASCII 1.25/字，向上取整）；非字符串降级 0 */
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

/** 非西文上界费率（单一真相：估算与压缩件的字符预算反算共用）——主流 tokenizer
 *  对 CJK/西里尔/阿拉伯/emoji 均值 ≤1 token/char，留 25% 余量；纯 chars/4 对这些
 *  文字低估 3-5×（压缩水位晚触发已实证），请求压力估算必须按上界走 */
export const WIDE_TOKENS_PER_CHAR = 1.25;

// 非 ASCII 判定 = 「可打印 ASCII 区间之外」：\t\n\r 控制空白按 len/4 计（不进上界
// 桶——日志/JSON 类内容不虚高 5-13%），用字符串字面量白名单而非控制字符正则表达
const NON_PRINTABLE_RE = /[^\x20-\x7e]/g;

function countControlWhitespace(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === "\t" || ch === "\n" || ch === "\r") count += 1;
  }
  return count;
}

/** 可打印 ASCII 与控制空白按 len/4、其余文字（CJK/西里尔/emoji 等）按 1.25/char，
 *  向上取整（UTF-16 code unit 计长）——请求压力上界口径（压缩件的预留口径，
 *  docs/TOKEN-METER.md §5 裁决生效）；非字符串降级 0 */
export function estimateText(text: string): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  const nonPrintable = text.match(NON_PRINTABLE_RE)?.length ?? 0;
  const wideCount = nonPrintable - countControlWhitespace(text);
  return Math.ceil(wideCount * WIDE_TOKENS_PER_CHAR + (text.length - wideCount) / 4);
}
