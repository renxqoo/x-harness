// 语义持久检查点（docs/SESSION-CHECKPOINT.md §1）：三个语义边界的 flush 屏障。
// 模型请求前（agentRequest——此时 system/user 已落账）与工具副作用前（toolsExecute——
// tool/call 记录先于工具体持久，崩溃后可判别「已派发 outcome unknown」vs「未启动」）
// fail-closed：flush 失败一律 throw（不借「未调 next」违约文本当控制流），请求侧逃逸
// driver 收 error turn/end、工具侧被 dispatch 管线收敛为携带 reason 的 isError outcome。
// turn 收尾后（sessionAuditEvent 过滤 turn/end——审计通道微任务级投递，session 闭合词表，
// 与 autocompact 同款先例）告警式：turn 已收尾无下游可阻断，flush 失败告警不阻断，pending
// 保留由下一 agentRequest 屏障（fail-closed）与 dispose drain-then-close 兜底重试。排序：
// 桥接 onFlush 先同步排空审计队列再派发 sessionFlush——本屏障发起时 turn/end 必已入持久化
// pending（结构性保证，与监听器注册序无关）；同一 per-session 串行链 FIFO 保证先于下一
// turn 的请求屏障；whenIdle/idle 状态不承诺字节已 fsync，读盘必经 flush 屏障。
// 装配契约（softInject ["session-persistence-jsonl"] topo 固化）：持久化在场时先装载——
// teardown 逆序回卷本插件挂点先拆、持久化终排空殿后；调换会使拆除期触发的 flush 落进
// 空屏障（成功不承诺字节）。运行期覆盖与装载序无关：flush 的结构性排空 + drain 至少晚一
// 个 microtask，恒含 turn/end。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentRequest } from "@x-harness/agent-loop";
import type { Dial } from "@x-harness/agent-loop";
import { sessionAuditEvent, sessionDisposed, sessionStore } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { toolsExecute } from "@x-harness/tools";
import type { ToolCallRequest, ToolOutcome } from "@x-harness/tools";
import { checkpointDiagnostic } from "./tokens.ts";

type AgentRequestPayload = {
  readonly session: SessionId;
  readonly turn: number;
  readonly step: number;
  readonly dial: Dial;
  readonly signal: AbortSignal;
};

export const sessionCheckpointPlugin: Plugin = {
  name: "session-checkpoint",
  inject: ["session"], // P16：不挂 llm/stream，请求侧挂点在 agentRequest（更早覆盖同一边界）
  softInject: ["session-persistence-jsonl"], // 装配契约 topo 固化：持久化在场时先装载（拆除殿后）；缺席 = inline 会话组合正常跳过
  apply: (ctx: Context): Disposer => {
    const store = ctx.use(sessionStore);

    const checkpoint = async (session: SessionId): Promise<void> => {
      const flushed = await store.flush(session); // 空屏障语义：未装持久化时成功不承诺字节
      if (!flushed.ok) throw new Error(`checkpoint-flush-failed:${flushed.reason}`);
    };

    // 同会话只告警一次：dead 闩会话连跑多 turn 不刷屏；sessionDisposed 摘除防泄漏。
    // 闩位在送达成功之后——告警通道故障（write throw）时不闩，catch 重告仍可送达
    const warned = new Set<SessionId>();
    const warnTurnEndFlush = (session: SessionId, reason: string): void => {
      if (warned.has(session)) return;
      process.stderr.write(`session-checkpoint/turn-end-flush-failed session=${session} ${JSON.stringify({ reason })}\n`);
      ctx.emit(checkpointDiagnostic, { session, code: "turn-end-flush-failed", detail: { reason } }); // 事件总线可见（不只 stderr）
      warned.add(session);
    };

    const offTurnEnd = ctx.on(sessionAuditEvent, ({ session, event }) => {
      if (event.type !== "turn/end") return;
      // 屏障发起推迟一个微任务：本批审计投递完整落地后再生效——不在投递循环内派发
      // sessionFlush（桥接重入卫兵已封重入面，此处进一步把发起点挪出循环；下一 turn 的
      // 请求屏障远在其后，覆盖不受影响）
      queueMicrotask(() => {
        void store
          .flush(session)
          .then((flushed) => {
            if (!flushed.ok) warnTurnEndFlush(session, flushed.reason); // 通道故障 throw → 落入 catch 重告
          })
          .catch(() => {
            warnTurnEndFlush(session, "warn-channel-failed"); // store.flush 恒 resolve：此路只兜告警通道自身故障
          });
      });
    });

    const offDisposed = ctx.on(sessionDisposed, ({ session }: { session: SessionId }) => {
      warned.delete(session);
    });

    const offRequest = ctx.on(agentRequest, async (payload: AgentRequestPayload, next: (input: AgentRequestPayload) => Promise<Dial>): Promise<Dial> => {
      await checkpoint(payload.session); // 失败即 throw：适配器零派发
      return next(payload);
    });

    const offExecute = ctx.on(
      toolsExecute,
      async (request: ToolCallRequest, next: (req: ToolCallRequest) => Promise<ToolOutcome>): Promise<ToolOutcome> => {
        if (request.session !== undefined) await checkpoint(request.session); // 非 agent 调用方（无 session）直通
        return next(request);
      },
    );

    return () => {
      offTurnEnd();
      offDisposed();
      offRequest();
      offExecute();
    };
  },
};
