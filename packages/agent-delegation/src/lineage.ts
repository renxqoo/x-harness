import type { SettlementSink } from "./tokens.ts";
import type { AgentHandle } from "@x-harness/agent-loop";
import type { ToolFilter } from "@x-harness/tools";
import type { Session, SessionEvent, SessionId } from "@x-harness/session";
import type { LoadedAgentType } from "./types.ts";

export interface ChildRow {
  readonly agentId: string;
  readonly sessionId: SessionId;
  readonly type: string;
  readonly parent: SessionId;
  readonly depth: number;
  readonly work?: string;
  occupied: boolean;
  armed: boolean;
  running: boolean;
  stopped: boolean;
  settlement?: SettlementSink;
  worktree?: string;
  worktreeRepoTop?: string;
}

export function createLineage() {
  const byAgentId = new Map<string, ChildRow>();
  const bySessionId = new Map<SessionId, string>();
  const rowOf = (session: SessionId): ChildRow | undefined => {
    const agentId = bySessionId.get(session);
    return agentId === undefined ? undefined : byAgentId.get(agentId);
  };
  return {
    register: (row: ChildRow): void => {
      byAgentId.set(row.agentId, row);
      bySessionId.set(row.sessionId, row.agentId);
    },
    drop: (sessionId: SessionId): void => {
      const agentId = bySessionId.get(sessionId);
      if (agentId === undefined) return;
      byAgentId.delete(agentId);
      bySessionId.delete(sessionId);
    },
    get: (agentId: string): ChildRow | undefined => byAgentId.get(agentId),
    bySession: rowOf,
    depthOf: (session: SessionId): number => rowOf(session)?.depth ?? 0,
    rows: (): readonly ChildRow[] => [...byAgentId.values()],
    occupiedBy: (parent: SessionId): number => [...byAgentId.values()].filter((row) => row.parent === parent && row.occupied).length,
  };
}

export type Lineage = ReturnType<typeof createLineage>;

export function mintAgentId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `agent-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function forkSeed(parentSession: Session): readonly SessionEvent[] {
  const events = parentSession.events();
  let lastTurnEnd = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if ((events[i] as SessionEvent).type === "turn/end") {
      lastTurnEnd = i;
      break;
    }
  }
  if (lastTurnEnd < 0) return [];
  const nodes = parentSession.surface().filter((node) => node.event.type === "system/message" || node.event.seq <= lastTurnEnd);
  return recastSurface(nodes.map((node) => node.event));
}

type SurfaceLikeEvent = SessionEvent;

function recastSurface(events: readonly SurfaceLikeEvent[]): SessionEvent[] {
  const seed: SessionEvent[] = [];
  for (const event of events) {
    const recast = recastOne(event, seed.length);
    if (recast !== undefined) seed.push(recast);
  }
  return seed;
}

function assistantRecastData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    turn: 0,
    step: 0,
    content: data["content"] ?? [],
    ...(data["thinking"] !== undefined ? { thinking: data["thinking"] } : {}),
    ...(data["thinkingBlocks"] !== undefined ? { thinkingBlocks: data["thinkingBlocks"] } : {}),
    ...(data["usage"] !== undefined ? { usage: data["usage"] } : {}),
    ...(data["stopReason"] !== undefined ? { stopReason: data["stopReason"] } : {}),
  };
}

function agentMessageRecast(data: Record<string, unknown>): { readonly turn: number; readonly step: number; readonly source: string; readonly kind: "content"; readonly content: unknown } | undefined {
  if (data["kind"] !== "content") return undefined;
  return { turn: 0, step: 0, source: typeof data["source"] === "string" ? data["source"] : "", kind: "content", content: data["content"] ?? [] };
}

function recastOne(event: SurfaceLikeEvent, seq: number): SessionEvent | undefined {
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case "system/message":
      return mint({ seq, type: "system/message", data: { turn: 0, step: 0, text: data["text"] ?? "" } });
    case "user/message":
      return mint({ seq, type: "user/message", data: { turn: 0, step: 0, content: data["content"] ?? [] } });
    case "assistant/message":
      return mint({ seq, type: "assistant/message", data: assistantRecastData(data) });
    case "tool/result":
      return mint({
        seq,
        type: "tool/result",
        data: {
          turn: 0,
          step: 0,
          callId: data["callId"] ?? "",
          content: data["content"] ?? "",
          ...(data["isError"] === true ? { isError: true } : {}),
        },
      });
    case "agent/message": {
      const recast = agentMessageRecast(data);
      return recast === undefined ? undefined : mint({ seq, type: "agent/message", data: recast });
    }
    default:
      return undefined;
  }
}

function mint(spec: { seq: number; type: string; data: unknown }): SessionEvent {
  return { type: spec.type, seq: spec.seq, time: Date.now(), data: spec.data, surfaceOp: "append" } as SessionEvent;
}

export function splitDialRef(ref: string): { provider: string; model: string } | undefined {
  const index = ref.indexOf("/");
  if (index <= 0 || index === ref.length - 1) return undefined;
  return { provider: ref.slice(0, index), model: ref.slice(index + 1) };
}

export function inheritDial(
  parentHandle: AgentHandle,
  chain: {
    readonly type?: LoadedAgentType;
    readonly lastHeader?: { model?: string; provider?: string };
    readonly override?: { model?: string; provider?: string };
    readonly resolveProviderOf?: (model: string) => string | undefined;
  },
): { model?: string; provider?: string } {
  const model = chain.override?.model ?? chain.type?.model ?? parentHandle.agent.options.model ?? chain.lastHeader?.model;
  if (model === undefined) return {};
  const composite = splitDialRef(model);
  const provider = foldProvider(chain, { parentProvider: parentHandle.agent.options.provider, model, fromComposite: composite?.provider });
  return { model: composite?.model ?? model, ...(provider !== undefined ? { provider } : {}) };
}

function foldProvider(
  chain: {
    readonly type?: LoadedAgentType;
    readonly lastHeader?: { model?: string; provider?: string };
    readonly override?: { model?: string; provider?: string };
    readonly resolveProviderOf?: (model: string) => string | undefined;
  },
  spec: { readonly parentProvider: string | undefined; readonly model: string; readonly fromComposite: string | undefined },
): string | undefined {
  const explicit = chain.override?.provider ?? chain.type?.provider;
  if (explicit !== undefined) return explicit;
  if (spec.fromComposite !== undefined) return spec.fromComposite;
  if (chain.resolveProviderOf !== undefined) {
    const resolved = chain.resolveProviderOf(spec.model);
    if (resolved !== undefined) return resolved;
  }
  return spec.parentProvider ?? chain.lastHeader?.provider;
}

export function narrowTools(callerTools: ToolFilter | undefined, typeTools: readonly string[] | undefined): ToolFilter | undefined {
  if (typeTools === undefined) return callerTools;
  if (callerTools === undefined) return typeTools;
  if (callerTools === "deny-all") return [];
  const caller = new Set(callerTools);
  return typeTools.filter((name) => caller.has(name));
}
