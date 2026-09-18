// 跨进程消费面（docs/AGENT-DELEGATION.md §5.3/§5.4）：一 box 一 drain（pollInterval 轮询，
// rename 抢占单读者）→ 信封 steer 宿主 main 会话；main 会话 agentStatus 边沿即时镜像
// manifest.status；main 转 idle → 一次性订阅结算；dispose 序列「停 drain → 停心跳 →
// 结算 subs → 关箱删目录」全部经 ctx.effect 挂接（定时器 unref）。

import type { AgentLoopService } from "@x-harness/agent-loop";
import type { SessionId } from "@x-harness/session";
import type { BoxHandle, MailboxService } from "@x-harness/session-mailbox";

export interface MailboxConsumerDeps {
  readonly service: MailboxService;
  readonly loop: AgentLoopService;
  readonly box: BoxHandle;
  /** 宿主 main 会话（信封路由目的地） */
  readonly mainSession: SessionId;
  readonly onWarn?: (message: string) => void;
}

export interface MailboxConsumer {
  /** drain 单拍（测试确定性入口；运行期由 start 的定时器驱动） */
  drainOnce(): Promise<void>;
  /** main 会话状态镜像单拍（agentStatus 边沿由 plugin 调用） */
  mirrorStatus(status: "running" | "idle"): Promise<void>;
  /** 一次性 idle 订阅结算：向各订阅方投 notice 并摘除 */
  settleSubs(): Promise<void>;
  /** 停 drain/心跳 → 结算 → 关箱（插件 dispose 序列） */
  shutdown(): Promise<void>;
}

export function createMailboxConsumer(deps: MailboxConsumerDeps): MailboxConsumer {
  const { service, loop, box, mainSession } = deps;

  const deliver = async (from: string, message: string): Promise<void> => {
    const mainHandle = loop.get(mainSession);
    if (mainHandle === undefined) {
      deps.onWarn?.(`mailbox: envelope from ${from} dropped (main session not live)`);
      return; // at-most-once：主会话未建/已封存——接受丢失（§5.3）
    }
    try {
      mainHandle.agent.steer(`<cross-session-message from="${from}">${message}</cross-session-message>`);
    } catch {
      deps.onWarn?.(`mailbox: envelope from ${from} dropped (main session sealing)`);
    }
  };

  const settleSubs = async (): Promise<void> => {
    for (const from of await service.subs.list(box.name)) {
      const sent = await service.send(from, {
        from: box.name,
        message: `[Cross-session idle notice] ${box.name} idle at ${String(service.timing.now())}`,
        kind: "idle-notice",
      });
      if (!sent.ok) deps.onWarn?.(`mailbox: idle notice to ${from} undeliverable (${sent.reason ?? "?"})`);
      await service.subs.remove(box.name, from); // 一次性；from 死也摘（订阅随目标存活期终结）
    }
  };

  return {
    drainOnce: async () => {
      for (const envelope of await service.drain(box.name)) {
        await deliver(envelope.from, envelope.message);
      }
    },
    mirrorStatus: (status) => box.setStatus(status),
    settleSubs,
    shutdown: async () => {
      await settleSubs().catch(() => {
        /* 结算尽力：关箱不被单次投递失败阻塞 */
      });
      await box.close();
    },
  };
}

/** drain 定时循环（unref；返回停止函数） */
export function startDrain(consumer: MailboxConsumer, intervalMs: number, onWarn?: (message: string) => void): () => void {
  const timer = setInterval(() => {
    void consumer.drainOnce().catch((error: unknown) => {
      onWarn?.(`mailbox: drain failed (${String(error)})`);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
