// session 插件：装配仓库与总线 token 的桥接回调（docs/SESSION.md §1.1、§1.2 双通道契约）。
// sessionEvent = UI 同步观察面（仅宿主渲染消费）；sessionAuditEvent = 任务处理面（微任务级
// 投递，投递序 = 日志序——投递循环内监听器 append 的事件恒续排本批之后，重入排空被卫兵
// 挡回外层循环）。时序契约（协议约束，非实现巧合）：审计投递只准 queueMicrotask；
// onFlush 先排空审计队列再派发 sessionFlush——「flush 成功 ⇒ 屏障发起前已 append 的事件
// 已入持久化 pending」（发起后同批在途事件在 drain 段执行前必已入账——drain 段至少晚一个
// 微任务）；contextDisposing 广播时（回卷最先、监听器全存活）排空残余队列，sessionAuditDrain
// 端口兜单插件卸载窗口。

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
    // 审计投递队列：原子 swap 排空——微任务/flush 结构排空/teardown/卸载四路径共用，不重复投递。
    // 重入卫兵：投递循环内监听器（如 checkpoint 发起 store.flush → onFlush 重入）不当场排空——
    // 循环改为按队列头持续续排（投递序 = 日志序是结构不变量：批次中段 append 的事件恒排在本批之后）
    let queued: AuditItem[] = [];
    let scheduled = false;
    let delivering = false;
    function deliverAudit(): void {
      if (delivering) return; // 重入：外层 while 会续排到底，本次 flush 的 drain 段在微任务后执行
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
        ctx.emit(sessionEvent, { session, event }); // UI 通道：同步观察面
        queued.push({ session, event });
        scheduleAudit(); // 审计通道：微任务级投递
      },
      onGuard: (header) => ctx.dispatch(sessionCreateGuard, { header }),
      onCreated: (header) => {
        ctx.emit(sessionCreated, { header });
      },
      onFlush: async (session) => {
        deliverAudit(); // 结构性排空：flush 生效前残余审计事件必已投递（含持久化入账）
        await ctx.dispatch(sessionFlush, { session });
      },
      onDisposed: (session) => {
        ctx.emit(sessionDisposed, { session });
      },
    });
    ctx.provide(sessionStore, store);
    ctx.provide(sessionAuditDrain, { drain: deliverAudit });
    const offDisposing = ctx.on(contextDisposing, () => {
      // 回卷最先广播（此时全部审计监听器仍存活）：残余事件入账后由持久化终排空落盘；
      // emit 无 live 断言——监听器已拆的投递静默，故必须在此点而非插件 disposer 排空
      deliverAudit();
    });
    return () => {
      offDisposing();
      deliverAudit(); // 单插件卸载面：残余审计事件先投递（监听器仍存活），再封存会话
      for (const id of store.list()) store.dispose(id);
    };
  },
} satisfies Plugin;
