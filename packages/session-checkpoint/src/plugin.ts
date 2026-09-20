// 语义持久检查点（docs/SESSION-CHECKPOINT.md §1）：三个语义边界的 flush 屏障。
// 模型请求前（agentRequest——此时 system/user 已落账）与工具副作用前（toolsExecute——
// tool/call 记录先于工具体持久，崩溃后可判别「已派发 outcome unknown」vs「未启动」）
// fail-closed：flush 失败一律 throw（不借「未调 next」违约文本当控制流），请求侧逃逸
// driver 收 error turn/end、工具侧被 dispatch 管线收敛为携带 reason 的 isError outcome。
// turn 收尾后（sessionEvent 过滤 turn/end——session 闭合词表，与 autocompact 同款先例）
// 告警式：turn 已收尾无下游可阻断，flush 失败告警不阻断，pending 保留由下一 agentRequest
// 屏障（fail-closed）与 dispose drain-then-close 兜底重试。异步 flush 经持久化层
// per-session 串行链在本轮同步广播（含 pending 入账）之后执行——drain 必含 turn/end
// 且先于下一 turn 的请求屏障；whenIdle/idle 状态不承诺字节已 fsync，读盘必经 flush 屏障。
// 装配契约：本插件须晚于 session-persistence-jsonl 装载（teardown 逆序回卷时本插件挂点
// 先拆、持久化终排空殿后）；调换会使拆除期触发落进空屏障（成功不承诺字节）。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentRequest } from "@x-harness/agent-loop";
import type { Dial } from "@x-harness/agent-loop";
import { sessionDisposed, sessionEvent, sessionStore } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { toolsExecute } from "@x-harness/tools";
import type { ToolCallRequest, ToolOutcome } from "@x-harness/tools";

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
  apply: (ctx: Context): Disposer => {
    const store = ctx.use(sessionStore);

    const checkpoint = async (session: SessionId): Promise<void> => {
      const flushed = await store.flush(session); // 空屏障语义：未装持久化时成功不承诺字节
      if (!flushed.ok) throw new Error(`checkpoint-flush-failed:${flushed.reason}`);
    };

    // 同会话只告警一次：dead 闩会话连跑多 turn 不刷屏；sessionDisposed 摘除防泄漏
    const warned = new Set<SessionId>();
    const warnTurnEndFlush = (session: SessionId, reason: string): void => {
      if (warned.has(session)) return;
      warned.add(session);
      process.stderr.write(`session-checkpoint/turn-end-flush-failed session=${session} ${reason}\n`);
    };

    const offTurnEnd = ctx.on(sessionEvent, ({ session, event }) => {
      if (event.type !== "turn/end") return;
      void store
        .flush(session)
        .then((flushed) => {
          if (!flushed.ok) warnTurnEndFlush(session, flushed.reason);
        })
        .catch((error: unknown) => {
          warnTurnEndFlush(session, error instanceof Error ? error.message : String(error)); // 后台异常是进程级崩溃面
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
