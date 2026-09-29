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
  inject: ["session"],
  softInject: ["session-persistence-jsonl"],
  apply: (ctx: Context): Disposer => {
    const store = ctx.use(sessionStore);

    const checkpoint = async (session: SessionId): Promise<void> => {
      const flushed = await store.flush(session);
      if (!flushed.ok) throw new Error(`checkpoint-flush-failed:${flushed.reason}`);
    };

    const warned = new Set<SessionId>();
    const warnTurnEndFlush = (session: SessionId, reason: string): void => {
      if (warned.has(session)) return;
      process.stderr.write(`session-checkpoint/turn-end-flush-failed session=${session} ${JSON.stringify({ reason })}\n`);
      ctx.emit(checkpointDiagnostic, { session, code: "turn-end-flush-failed", detail: { reason } });
      warned.add(session);
    };

    const offTurnEnd = ctx.on(sessionAuditEvent, ({ session, event }) => {
      if (event.type !== "turn/end") return;
      queueMicrotask(() => {
        void store
          .flush(session)
          .then((flushed) => {
            if (!flushed.ok) warnTurnEndFlush(session, flushed.reason);
          })
          .catch(() => {
            warnTurnEndFlush(session, "warn-channel-failed");
          });
      });
    });

    const offDisposed = ctx.on(sessionDisposed, ({ session }: { session: SessionId }) => {
      warned.delete(session);
    });

    const offRequest = ctx.on(agentRequest, async (payload: AgentRequestPayload, next: (input: AgentRequestPayload) => Promise<Dial>): Promise<Dial> => {
      await checkpoint(payload.session);
      return next(payload);
    });

    const offExecute = ctx.on(
      toolsExecute,
      async (request: ToolCallRequest, next: (req: ToolCallRequest) => Promise<ToolOutcome>): Promise<ToolOutcome> => {
        if (request.session !== undefined) await checkpoint(request.session);
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
