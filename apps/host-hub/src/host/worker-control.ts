import { isSafeSessionId } from "@x-harness/session";
import { FORK_GRACE_SIGTERM_MS } from "../shared/limits.ts";
import { INTERNAL_ID_PREFIX } from "../protocol/internal.ts";
import type { HubErrorShape } from "../shared/errors.ts";
import type { ThreadTable } from "./thread-table.ts";
import type { ControlFrame } from "./worker-frames.ts";

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
  resumeWaiter: { resolve: (ok: boolean, reason?: HubErrorShape) => void } | undefined;
}

function plausiblePayload(payload: { threadId?: unknown; sessionPath?: unknown }): boolean {
  const idOk = typeof payload.threadId === "string" && isSafeSessionId(payload.threadId);
  const pathOk = payload.sessionPath === undefined || (typeof payload.sessionPath === "string" && payload.sessionPath.startsWith("/") && (payload.sessionPath as string).endsWith("/events.jsonl"));
  return idOk && pathOk;
}

export function createControlRouter(deps: { table: ThreadTable; emitClient: (line: string) => void }) {
  function internalAckResponse(slot: ControlSlot, frame: ControlFrame): boolean {
    const failure = frame.data === undefined;
    slot.resumeWaiter?.resolve(!failure, failure ? frame.error : undefined);
    slot.resumeWaiter = undefined;
    return false;
  }

  function startResumeResponse(ctx: ControlContext, frame: ControlFrame): boolean {
    if (frame.error !== undefined) {
      process.stderr.write(`hub: worker rejected ${frame.command}: ${frame.error}\n`);
      ctx.slot.worker.kill(FORK_GRACE_SIGTERM_MS);
      return true;
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
      ctx.slot.worker.kill(FORK_GRACE_SIGTERM_MS);
      return true;
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
