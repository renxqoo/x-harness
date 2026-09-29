import type { AgentLoopService } from "@x-harness/agent-loop";
import type { SessionId } from "@x-harness/session";
import type { BoxHandle, MailboxService } from "@x-harness/session-mailbox";

export interface MailboxConsumerDeps {
  readonly service: MailboxService;
  readonly loop: AgentLoopService;
  readonly boxRef: { current: BoxHandle };
  readonly mainRef: { current: SessionId };
  readonly onWarn?: (message: string) => void;
}

export interface MailboxConsumer {
  drainOnce(): Promise<void>;
  mirrorStatus(status: "running" | "idle"): Promise<void>;
  settleSubs(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createMailboxConsumer(deps: MailboxConsumerDeps): MailboxConsumer {
  const { service, loop, boxRef, mainRef } = deps;

  const deliver = async (from: string, message: string): Promise<void> => {
    const mainHandle = loop.get(mainRef.current);
    if (mainHandle === undefined) {
      deps.onWarn?.(`mailbox: envelope from ${from} dropped (main session not live)`);
      return;
    }
    try {
      mainHandle.agent.steer(`<cross-session-message from="${from}">${message}</cross-session-message>`);
    } catch {
      deps.onWarn?.(`mailbox: envelope from ${from} dropped (main session sealing)`);
    }
  };

  let settling: Promise<void> | undefined;
  const settleOnce = async (): Promise<void> => {
    for (const from of await service.subs.list(boxRef.current.name)) {
      const sent = await service.send(from, {
        from: boxRef.current.name,
        message: `[Cross-session idle notice] ${boxRef.current.name} idle at ${String(service.timing.now())}`,
        kind: "idle-notice",
      });
      if (!sent.ok) deps.onWarn?.(`mailbox: idle notice to ${from} undeliverable (${sent.reason ?? "?"})`);
      await service.subs.remove(boxRef.current.name, from);
    }
  };
  const settleSubs = (): Promise<void> => {
    settling ??= settleOnce().finally(() => {
      settling = undefined;
    });
    return settling;
  };

  return {
    drainOnce: async () => {
      for (const envelope of await service.drain(boxRef.current.name)) {
        await deliver(envelope.from, envelope.message);
      }
    },
    mirrorStatus: (status) => boxRef.current.setStatus(status),
    settleSubs,
    shutdown: async () => {
      await settleSubs().catch(() => {
      });
      await boxRef.current.close();
    },
  };
}

export function startDrain(consumer: MailboxConsumer, intervalMs: number, onWarn?: (message: string) => void): () => void {
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    const timer = setTimeout(() => {
      void consumer
        .drainOnce()
        .catch((error: unknown) => {
          onWarn?.(`mailbox: drain failed (${String(error)})`);
        })
        .finally(tick);
    }, intervalMs);
    timer.unref?.();
  };
  tick();
  return () => {
    stopped = true;
  };
}
