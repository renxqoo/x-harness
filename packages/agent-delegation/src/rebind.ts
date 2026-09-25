// 会话切换邮箱重绑（docs/AGENT-DELEGATION.md §5.3 宿主接线）：宿主 REPL /new、/resume
// 切会话后换箱 + 换信封路由目的地——装配期钉死则切换后信封全部丢失。

import type { SessionId } from "@x-harness/session";
import type { BoxHandle } from "@x-harness/session-mailbox";
import type { AgentLoopService } from "@x-harness/agent-loop";
import type { CrossDeps } from "./crossmsg.ts";

/** mailbox 可变绑定面（plugin 装配期铸造一次；consumer/cross/镜像三面共享） */
export interface MailboxBinding {
  readonly mainRef: { current: SessionId };
  readonly boxRef: { current: BoxHandle | undefined };
  /** 心跳停止面（可替换——rebind 停旧起新；dispose 走 effect 回卷） */
  readonly setHeartbeat: (stop: (() => void) | undefined) => void;
  /** 会话切换重绑（宿主 REPL 专用动词——rebindMailbox 的绑定面闭包） */
  rebind(next: SessionId): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface RebindDeps {
  readonly loop: AgentLoopService;
  readonly cross: () => CrossDeps | undefined;
  /** 本进程活箱句柄（可变——换箱后 drain/心跳/镜像/关箱全跟随新句柄） */
  readonly boxRef: { current: BoxHandle | undefined };
  /** 心跳停止面（可替换——停旧心跳起新心跳） */
  readonly setHeartbeat: (stop: (() => void) | undefined) => void;
  readonly mainRef: { current: SessionId };
  readonly swapCross: (next: CrossDeps) => void;
  readonly onWarn?: (message: string) => void;
}

/** 重绑：先开新箱 xh-<新id>（失败 = 保持旧绑定如实失败，不静默断链）→ 引用换目标 →
 *  旧箱尾信尽力取投新会话（steer 失败丢弃，at-most-once）→ 停旧心跳关旧箱。
 *  旧箱关失败仅告警（7 天陈尸回收兜底）。 */
export async function rebindMailbox(deps: RebindDeps, next: SessionId): Promise<{ ok: true } | { ok: false; reason: string }> {
  const current = deps.cross();
  if (current === undefined) return { ok: false, reason: "invalid-args:no mailbox configured" };
  const nextBox = `xh-${String(next)}`;
  let opened: BoxHandle;
  try {
    opened = await current.service.open(nextBox);
  } catch (error) {
    return { ok: false, reason: `spawn-failed:mailbox reopen ${error instanceof Error ? error.message : String(error)}` };
  }
  const previous = deps.boxRef.current;
  const previousBox = current.box;
  deps.boxRef.current = opened;
  const swapped: CrossDeps = { ...current, box: nextBox };
  deps.swapCross(swapped);
  deps.mainRef.current = next;
  await deliverTail(deps, previousBox);
  await closePrevious(deps, previous, previousBox);
  deps.setHeartbeat(opened.startHeartbeat());
  return { ok: true };
}

/** 旧箱尾信尽力取（drain 抢占语义）投递到新会话 */
async function deliverTail(deps: RebindDeps, previousBox: string): Promise<void> {
  const tail = await deps.cross()?.service.drain(previousBox).catch(() => []) ?? [];
  const mainHandle = deps.loop.get(deps.mainRef.current);
  if (mainHandle === undefined) return;
  for (const envelope of tail) {
    try {
      mainHandle.agent.steer(`<cross-session-message from="${envelope.from}">${envelope.message}</cross-session-message>`);
    } catch {
      /* 新会话恰在封存：尾信丢弃（at-most-once） */
    }
  }
}

/** 停旧心跳 + 关旧箱（关失败告警——陈尸回收兜底；bootId CAS 保证不误删对端认领的新箱） */
async function closePrevious(deps: RebindDeps, previous: BoxHandle | undefined, previousBox: string): Promise<void> {
  // 心跳停止面由调用方持有——此处经 deps.setHeartbeat(undefined) 语义停旧
  if (previous === undefined) return;
  const closed = await previous.close().then(() => true, () => false);
  if (closed !== true) deps.onWarn?.(`agents: previous mailbox box not closable (${previousBox}) — stale until reclaim`);
}

export interface BindingDeps {
  readonly loop: AgentLoopService;
  readonly mailbox: { readonly box: string; readonly mainSession: SessionId } | undefined;
  /** cross/verbDeps 双写回（plugin 持有的两个可变槽） */
  readonly swapCross: (next: CrossDeps | undefined, previous: CrossDeps | undefined) => void;
  readonly readCross: () => CrossDeps | undefined;
  readonly onWarn?: (message: string) => void;
}

/** 装配期铸造绑定面：mailbox 缺席形态 rebind 恒拒（进程内部署无跨进程面可换） */
export function createMailboxBinding(deps: BindingDeps): MailboxBinding {
  const mainRef: { current: SessionId } = { current: deps.mailbox?.mainSession ?? ("" as SessionId) };
  const boxRef: { current: BoxHandle | undefined } = { current: undefined };
  let stopHeartbeat: (() => void) | undefined;
  const setHeartbeat = (stop: (() => void) | undefined): void => {
    stopHeartbeat?.();
    stopHeartbeat = stop;
  };
  return {
    mainRef,
    boxRef,
    setHeartbeat,
    rebind: (next) =>
      rebindMailbox(
        {
          loop: deps.loop,
          cross: deps.readCross,
          boxRef,
          setHeartbeat,
          mainRef,
          swapCross: (nextCross) => deps.swapCross(nextCross, deps.readCross()),
          ...(deps.onWarn !== undefined ? { onWarn: deps.onWarn } : {}),
        },
        next,
      ),
  };
}
