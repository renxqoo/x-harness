import { deepFreeze } from "@x-harness/core";
import { gateEvent, parseSurfaceOp } from "./gates.ts";
import { materializeJson } from "./snapshot.ts";
import { applySurfaceEvent, isSurfaceEventType, projectSurface, surfaceToMessages } from "./surface.ts";
import type { Result } from "@x-harness/core";
import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
  SurfaceEventType,
  SurfaceIntent,
  SurfaceNode,
} from "./types.ts";

export interface SessionHandle {
  readonly session: Session;
  readonly seal: () => void;
}

export interface CreateSessionInput {
  readonly header: SessionHeader;
  readonly seed: readonly SessionEvent[];
  readonly inherited: boolean;
  readonly onAppend: (session: SessionId, event: SessionEvent) => void;
}

export function createSession(input: CreateSessionInput): SessionHandle {
  const log: SessionEvent[] = input.seed.map((event) => deepFreeze(materializeJson(event)) as SessionEvent);
  if (log.length > 0) {
    const marker = input.inherited ? { inherited: true } : {};
    log.push(deepFreeze({ type: "session/end-seed", seq: log.length, time: Date.now(), data: marker }) as SessionEvent);
  }
  let nodes: readonly SurfaceNode[] = projectSurface(log);
  let sealed = false;
  let appending = false;

  const session: Session = {
    id: input.header.id,
    header: input.header,
    events: () => Object.freeze([...log]),
    surface: () => Object.freeze([...nodes]),
    deriveMessages: () => Object.freeze(surfaceToMessages(nodes).map((message) => Object.freeze(message))),
    append: ((type: string, data: unknown, intent?: SurfaceIntent): Result<SessionEvent> => {
      if (sealed) return { ok: false, reason: "session-disposed" };
      if (appending) return { ok: false, reason: "append-reentrant" };
      const surface = isSurfaceEventType(type);
      if (surface !== (intent !== undefined)) {
        return { ok: false, reason: surface ? "surface-intent-required" : "surface-intent-not-allowed" };
      }
      const parsedOp = surface ? parseSurfaceOp((intent as { surfaceOp?: unknown } | null)?.surfaceOp) : undefined;
      if (surface && parsedOp === undefined) return { ok: false, reason: "surface-op-invalid" };
      let snapshot: unknown;
      try {
        snapshot = materializeJson(data);
      } catch {
        return { ok: false, reason: `not-json-safe:${type}` };
      }
      const gateErr = gateEvent(type, snapshot);
      if (gateErr !== undefined) return { ok: false, reason: gateErr };
      const event = deepFreeze({
        type,
        seq: log.length,
        time: Date.now(),
        data: snapshot,
        ...(parsedOp !== undefined ? { surfaceOp: parsedOp } : {}),
      }) as SessionEvent;
      if (parsedOp !== undefined) {
        const step = applySurfaceEvent(nodes, event as SessionEvent<SurfaceEventType>);
        if (!step.ok) return { ok: false, reason: step.reason };
        log.push(event);
        nodes = step.nodes;
      } else {
        log.push(event);
      }
      appending = true;
      try {
        input.onAppend(input.header.id, event);
      } finally {
        appending = false;
      }
      return { ok: true, value: event };
    }) as Session["append"],
  };
  return {
    session: Object.freeze(session),
    seal: () => {
      sealed = true;
    },
  };
}
