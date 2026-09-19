// Session 件的 7 个 token：2 服务 + 5 总线（docs/SESSION.md §1.2）。
// emit 三 token 定 freeze "none"——信封/header 在构造期已深冻，广播不重复遍历大载荷。

import { defineEvent, defineGuard, defineParallel, defineService } from "@x-harness/core";
import type { SessionArchive, SessionEvent, SessionHeader, SessionId, SessionStore } from "./types.ts";

export const sessionStore = defineService<SessionStore>("session-store");

/** 恢复档案端口：由持久化插件 provide（当前唯一实现 @x-harness/session-persistence-jsonl） */
export const sessionArchive = defineService<SessionArchive>("session-archive");

/** 每条诞生路径（create 与 fork）落账前的否决点：任一 deny → 会话不诞生 */
export const sessionCreateGuard = defineGuard<{ readonly header: SessionHeader }>("session/create-guard");

/** 诞生路径全部落账后广播，恰好一次 */
export const sessionCreated = defineEvent<{ readonly header: SessionHeader }>("session/created", { freeze: "none" });

/** 活回路 append 成功后同步广播；构造期事件（seed 前缀 + end-seed）不逐条广播，经 created 首灌覆盖 */
export const sessionEvent = defineEvent<{ readonly session: SessionId; readonly event: SessionEvent }>("session/event", {
  freeze: "none",
});

/** 落盘屏障：store.flush 派发，all-settled，聚合错误经 flush 的 Result 上浮 */
export const sessionFlush = defineParallel<{ readonly session: SessionId }>("session/flush");

/** store.dispose 移除并封存写权后广播，恰好一次 */
export const sessionDisposed = defineEvent<{ readonly session: SessionId }>("session/disposed", { freeze: "none" });
