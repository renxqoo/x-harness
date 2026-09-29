import type { SessionId } from "@x-harness/session";
import type { BoxHandle } from "@x-harness/session-mailbox";
import type { AgentLoopService } from "@x-harness/agent-loop";
import type { CrossDeps } from "./crossmsg.ts";

export interface MailboxBinding {
  readonly mainRef: { current: SessionId };
  readonly boxRef: { current: BoxHandle | undefined };
  readonly setHeartbeat: (stop: (() => void) | undefined) => void;
  rebind(next: SessionId): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface RebindDeps {
  readonly loop: AgentLoopService;
  readonly cross: () => CrossDeps | undefined;
  readonly boxRef: { current: BoxHandle | undefined };
  readonly setHeartbeat: (stop: (() => void) | undefined) => void;
  readonly mainRef: { current: SessionId };
  readonly swapCross: (next: CrossDeps) => void;
  readonly onWarn?: (message: string) => void;
}

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

async function deliverTail(deps: RebindDeps, previousBox: string): Promise<void> {
  const tail = await deps.cross()?.service.drain(previousBox).catch(() => []) ?? [];
  const mainHandle = deps.loop.get(deps.mainRef.current);
  if (mainHandle === undefined) return;
  for (const envelope of tail) {
    try {
      mainHandle.agent.steer(`<cross-session-message from="${envelope.from}">${envelope.message}</cross-session-message>`);
    } catch {
    }
  }
}

async function closePrevious(deps: RebindDeps, previous: BoxHandle | undefined, previousBox: string): Promise<void> {
  if (previous === undefined) return;
  const closed = await previous.close().then(() => true, () => false);
  if (closed !== true) deps.onWarn?.(`agents: previous mailbox box not closable (${previousBox}) — stale until reclaim`);
}

export interface BindingDeps {
  readonly loop: AgentLoopService;
  readonly mailbox: { readonly box: string; readonly mainSession: SessionId } | undefined;
  readonly swapCross: (next: CrossDeps | undefined, previous: CrossDeps | undefined) => void;
  readonly readCross: () => CrossDeps | undefined;
  readonly onWarn?: (message: string) => void;
}

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
