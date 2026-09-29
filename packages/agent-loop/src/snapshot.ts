import type { Context, Disposer } from "@x-harness/core";
import type { Session, SessionId, SurfaceNode } from "@x-harness/session";
import type { AgentLoopService } from "./types.ts";
import type { Dial } from "./tokens.ts";
import { agentRequest, agentStatus } from "./tokens.ts";

export const SNAPSHOT_SUPERSEDES = "This snapshot supersedes earlier snapshots of this kind.";

export function snapshotEnvelope(kind: string, body: string): string {
  return `<snapshot kind="${kind}">\n${SNAPSHOT_SUPERSEDES}\n${body}\n</snapshot>`;
}

export function isSnapshotNode(node: SurfaceNode): boolean {
  const event = node.event;
  if (event.type !== "user/message" || event.surfaceOp !== "append") return false;
  const block = event.data.content[0];
  if (event.data.content.length !== 1 || block?.type !== "text") return false;
  const lines = block.text.split("\n");
  const head = lines[0];
  return typeof head === "string" && head.startsWith('<snapshot kind="') && head.endsWith(">") && lines[1] === SNAPSHOT_SUPERSEDES;
}

function envelopeHead(text: string): string | undefined {
  const head = text.split("\n", 1)[0] ?? "";
  return head.startsWith('<snapshot kind="') && head.endsWith(">") ? head : undefined;
}

function snapshotPresent(session: Session, text: string): boolean {
  const surface = session.surface();
  const head = envelopeHead(text);
  if (head === undefined) {
    return surface.some((node) => node.event.type === "user/message" && node.event.surfaceOp === "append"
      && node.event.data.content.length === 1 && node.event.data.content[0]?.type === "text" && node.event.data.content[0]?.text === text);
  }
  for (let i = surface.length - 1; i >= 0; i -= 1) {
    const node = surface[i];
    if (node === undefined || node.event.type !== "user/message" || node.event.surfaceOp !== "append") continue;
    if (node.event.data.content.length !== 1 || node.event.data.content[0]?.type !== "text") continue;
    const nodeText = node.event.data.content[0]?.text ?? "";
    if (envelopeHead(nodeText) !== head) continue;
    return nodeText === text;
  }
  return false;
}

export interface TailSnapshotSpec {
  readonly id: string;
  readonly render: (session: SessionId) => string;
  readonly onWarn?: (message: string) => void;
}

export function createTailSnapshot(input: {
  readonly ctx: Context;
  readonly loop: AgentLoopService;
  readonly spec: TailSnapshotSpec;
}): Disposer {
  const { ctx, loop, spec } = input;
  return ctx.on(agentStatus, (payload) => {
    if (payload.status !== "running") return;
    const session = loop.get(payload.session)?.agent.session;
    if (session === undefined) return;
    let text: string;
    try {
      text = spec.render(payload.session);
    } catch (error) {
      spec.onWarn?.(`snapshot(${spec.id}): render failed (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    if (text === "") return;
    if (snapshotPresent(session, text)) return;
    const appended = session.append(
      "user/message",
      { turn: 0, step: 0, content: [{ type: "text" as const, text }] },
      { surfaceOp: "append" },
    );
    if (!appended.ok) spec.onWarn?.(`snapshot(${spec.id}): append failed for session ${String(payload.session)} (${appended.reason})`);
  });
}

export interface RequestSnapshotSpec {
  readonly id: string;
  readonly render: (dial: Dial) => string;
  readonly onWarn?: (message: string) => void;
}

export function createRequestSnapshot(input: {
  readonly ctx: Context;
  readonly loop: AgentLoopService;
  readonly spec: RequestSnapshotSpec;
}): Disposer {
  const { ctx, loop, spec } = input;
  return ctx.on(agentRequest, async (payload, next) => {
    const out = await next(payload);
    const session = loop.get(payload.session)?.agent.session;
    if (session !== undefined && out !== undefined) {
      let text: string;
      try {
        text = spec.render(out);
      } catch (error) {
        spec.onWarn?.(`snapshot(${spec.id}): render failed (${error instanceof Error ? error.message : String(error)})`);
        return out;
      }
      if (text !== "" && !snapshotPresent(session, text)) {
        const appended = session.append(
          "user/message",
          { turn: 0, step: 0, content: [{ type: "text" as const, text }] },
          { surfaceOp: "append" },
        );
        if (!appended.ok) spec.onWarn?.(`snapshot(${spec.id}): append failed for session ${String(payload.session)} (${appended.reason})`);
      }
    }
    return out;
  });
}
