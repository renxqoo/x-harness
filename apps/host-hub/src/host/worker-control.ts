// 控制响应分派（DESIGN §7——从 worker-pool 拆出）：internal ack / start|resume /
// fork|clone / stop（默认透传）。payload 词法校验入表（畸形 worker 不得污染路由表：
// threadId 走内核 isSafeSessionId 词法、sessionPath 绝对路径 + events.jsonl 布局）。
import { isSafeSessionId } from "@x-harness/session";
import { FORK_GRACE_SIGTERM_MS } from "../shared/limits.ts";
import { INTERNAL_ID_PREFIX } from "../protocol/internal.ts";
import type { ThreadTable } from "./thread-table.ts";
import type { ControlFrame } from "./worker-frames.ts";

/** 控制响应分派上下文（slot 生命周期事实——trusted/cwd 为 spawn 期定值） */
export interface ControlContext {
  slot: ControlSlot;
  rebind: (next: string) => void;
  trusted: boolean;
  cwd: string;
}

export interface ControlSlot {
  threadId: string;
  worker: { kill(graceMs: number): void; eof(): void };
  retireIntent: "stop" | "retire" | undefined;
  resumeWaiter: { resolve: (ok: boolean, reason?: string) => void } | undefined;
}

/** threadId/sessionPath 入表词法（防畸形 worker 污染表） */
function plausiblePayload(payload: { threadId?: unknown; sessionPath?: unknown }): boolean {
  const idOk = typeof payload.threadId === "string" && isSafeSessionId(payload.threadId);
  const pathOk = payload.sessionPath === undefined || (typeof payload.sessionPath === "string" && payload.sessionPath.startsWith("/") && (payload.sessionPath as string).endsWith("/events.jsonl"));
  return idOk && pathOk;
}

export function createControlRouter(deps: { table: ThreadTable; emitClient: (line: string) => void }) {
  /** 内部 resume 应答（@hub-internal: 命名空间）：兑现等待者，不转发 */
  function internalAckResponse(slot: ControlSlot, frame: ControlFrame): boolean {
    const failure = frame.data === undefined;
    slot.resumeWaiter?.resolve(!failure, failure ? frame.error : undefined);
    slot.resumeWaiter = undefined;
    return false;
  }

  /** thread/start|resume 应答：失败（success=false）→ 转发 failure 帧给客户端 +
   *  回收 worker（无会话存在——close 结算对 internal pending 兑现等待者、对
   *  thread/start 的 @pending 占位撤除）；成功路径：payload 校验 → 占用冲突复核
   *  → 表落实 + 重绑 */
  function startResumeResponse(ctx: ControlContext, frame: ControlFrame): boolean {
    if (frame.error !== undefined) {
      process.stderr.write(`hub: worker rejected ${frame.command}: ${frame.error}\n`);
      ctx.slot.worker.kill(FORK_GRACE_SIGTERM_MS);
      return true; // 转发该 failure 帧（恰一响应由 worker 应答兑现）
    }
    const payload = frame.data as { threadId?: unknown; cwd?: unknown; sessionPath?: unknown } | undefined;
    if (
      payload === undefined ||
      typeof payload.threadId !== "string" ||
      typeof payload.cwd !== "string" ||
      typeof payload.sessionPath !== "string" ||
      !plausiblePayload(payload)
    ) {
      process.stderr.write(`hub: malformed control response (${frame.command})\n`);
      ctx.slot.worker.kill(FORK_GRACE_SIGTERM_MS); // 不可绑定的成功应答：回收（防僵尸）
      return true; // 逐字转发（客户端按 worker 原话对账）
    }
    const holder = deps.table.holderOf(payload.sessionPath);
    if (holder !== undefined && holder !== payload.threadId && holder !== ctx.slot.threadId) {
      process.stderr.write(`hub: session path conflict on ${frame.command}\n`);
      ctx.slot.worker.kill(FORK_GRACE_SIGTERM_MS);
      return true;
    }
    if (ctx.slot.threadId.startsWith("@pending")) {
      deps.table.insert({
        threadId: payload.threadId,
        cwd: payload.cwd,
        sessionPath: payload.sessionPath,
        state: "live",
        trusted: ctx.trusted,
        keepalive: false,
      });
    } else {
      deps.table.update(ctx.slot.threadId, {
        state: "live",
        cwd: payload.cwd,
        sessionPath: payload.sessionPath,
      });
    }
    ctx.rebind(payload.threadId);
    return true;
  }

  /** fork/clone 应答：payload 合法则表重键 + 重绑（坏 payload 静默透传） */
  function forkResponse(ctx: ControlContext, frame: ControlFrame): boolean {
    const payload = frame.data as { threadId?: unknown; previousThreadId?: unknown; sessionPath?: unknown } | undefined;
    if (
      payload !== undefined &&
      typeof payload.threadId === "string" &&
      typeof payload.previousThreadId === "string" &&
      typeof payload.sessionPath === "string" &&
      plausiblePayload(payload) &&
      plausiblePayload({ threadId: payload.previousThreadId })
    ) {
      const source = deps.table.get(payload.previousThreadId);
      deps.table.rekey(payload.previousThreadId, {
        threadId: payload.threadId,
        sessionPath: payload.sessionPath,
        cwd: source?.cwd ?? ctx.cwd,
        trusted: source?.trusted ?? ctx.trusted,
        state: "live",
      });
      ctx.rebind(payload.threadId);
    }
    return true;
  }

  /** 控制响应分派：internal ack / start|resume / fork|clone / stop（默认透传） */
  function routeControl(ctx: ControlContext, frame: ControlFrame): boolean {
    if (frame.id !== undefined && frame.id.startsWith(INTERNAL_ID_PREFIX)) {
      return internalAckResponse(ctx.slot, frame);
    }
    if (frame.command === "thread/start" || frame.command === "thread/resume") {
      return startResumeResponse(ctx, frame);
    }
    if (frame.command === "fork" || frame.command === "clone") {
      return forkResponse(ctx, frame);
    }
    if (frame.command === "thread/stop") {
      ctx.slot.retireIntent = "stop";
      ctx.slot.worker.eof();
      return true;
    }
    return true;
  }

  return routeControl;
}
