// Session 件的 9 个 token：3 服务 + 6 总线（docs/SESSION.md §1.2）。
// emit 三 token 定 freeze "none"——信封/header 在构造期已深冻，广播不重复遍历大载荷。

import { defineEvent, defineGuard, defineParallel, defineService } from "@x-harness/core";
import type { SessionArchive, SessionEvent, SessionHeader, SessionId, SessionStore } from "./types.ts";

export const sessionStore = defineService<SessionStore>("session-store");

/** 恢复档案端口：由持久化插件 provide（当前唯一实现 @x-harness/session-persistence-jsonl） */
export const sessionArchive = defineService<SessionArchive>("session-archive");

/** 审计投递排空端口：session 桥接 provide；不经 context.dispose 的单插件卸载面在拆监听前
 *  先排空残余审计队列（同步 emit、原子 swap——与微任务投递不重复） */
export const sessionAuditDrain = defineService<{ drain(): void }>("session-audit-drain");

/** 每条诞生路径（create 与 fork）落账前的否决点：任一 deny → 会话不诞生 */
export const sessionCreateGuard = defineGuard<{ readonly header: SessionHeader }>("session/create-guard");

/** 诞生路径全部落账后广播，恰好一次 */
export const sessionCreated = defineEvent<{ readonly header: SessionHeader }>("session/created", { freeze: "none" });

/** 活回路 append 成功后同步广播（UI 观察面——仅宿主渲染消费，禁止任务处理）；
 *  构造期事件（seed 前缀 + end-seed）不逐条广播，经 created 首灌覆盖 */
export const sessionEvent = defineEvent<{ readonly session: SessionId; readonly event: SessionEvent }>("session/event", {
  freeze: "none",
});

/** 审计通道：与 sessionEvent 同载荷，微任务级异步投递（投递序 = 日志序、不丢不重——投递
 *  循环内 append 的事件续排本批之后）——任务处理消费者（持久化/checkpoint/计量/压缩状态/
 *  第三方 tap）专用。投递时序契约（协议约束）：桥接只准 queueMicrotask 调度（禁
 *  setTimeout/setImmediate——微任务与 promise reaction 同 FIFO 是 V8/JSC 运行时事实，
 *  换宏任务即破坏全部屏障时序）；store.flush 先排空本队列再派发 sessionFlush（重入排空
 *  被卫兵挡回外层投递循环——flush 生效时本批在途事件必已入账） */
export const sessionAuditEvent = defineEvent<{ readonly session: SessionId; readonly event: SessionEvent }>(
  "session/audit-event",
  { freeze: "none" },
);

/** 落盘屏障：store.flush 派发，all-settled，聚合错误经 flush 的 Result 上浮 */
export const sessionFlush = defineParallel<{ readonly session: SessionId }>("session/flush");

/** store.dispose 移除并封存写权后广播，恰好一次 */
export const sessionDisposed = defineEvent<{ readonly session: SessionId }>("session/disposed", { freeze: "none" });
