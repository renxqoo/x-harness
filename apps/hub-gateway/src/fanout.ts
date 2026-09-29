import type { EventBody, Frame } from "@x-harness/remote-protocol";
import { OutboxStream, REPLAY_BUFFER_MAX } from "@x-harness/remote-protocol";

export type HostFrameKind = "response" | "event" | "ui_request" | "heartbeat" | "hub_error" | "thread_died" | "thread_parked" | "unknown";

export function classifyHostLine(line: string): HostFrameKind {
  if (line.startsWith('{"id":')) return "response";
  if (line.startsWith('{"type":"response"')) return "response";
  if (line.startsWith('{"type":"event"')) return "event";
  if (line.startsWith('{"type":"ui_request"')) return "ui_request";
  if (line.startsWith('{"type":"heartbeat"')) return "heartbeat";
  if (line.startsWith('{"type":"hub_error"')) return "hub_error";
  if (line.startsWith('{"type":"thread_died"')) return "thread_died";
  if (line.startsWith('{"type":"thread_parked"')) return "thread_parked";
  return "unknown";
}

export interface ClientTarget {
  target: string;
  tier: "read" | "interact" | "full" | "owner";
  subscribedThreads: Set<string>;
  send(frame: Frame): void;
}

export type TierResolver = (target: string) => "read" | "interact" | "full" | "owner";

export interface FanoutOptions {
  coalesceBacklogFrames: number;
  coalesceLagMs: number;
  now(): number;
}

const COALESCABLE = new Set(["agent/assistant-stream", "llm/chunk", "agent/tool-stream", "bash_execution_update"]);

export class Fanout {
  private readonly targets = new Map<string, ClientTarget>();
  private tierResolver: TierResolver | null = null;
  private readonly outboxes = new Map<string, OutboxStream>();
  private readonly perThreadSeq = new Map<string, number>();
  private hostIdCounter = 0;

  constructor(private readonly options: FanoutOptions) {}

  attach(target: ClientTarget): void {
    this.targets.set(target.target, target);
  }

  setTierResolver(resolver: TierResolver | null): void {
    this.tierResolver = resolver;
  }

  effectiveTier(target: string): "read" | "interact" | "full" | "owner" {
    const stored = this.targets.get(target);
    if (stored === undefined) return "read";
    return this.tierResolver !== null ? this.tierResolver(target) : stored.tier;
  }

  detach(targetId: string): void {
    this.targets.delete(targetId);
    for (const key of this.outboxes.keys()) {
      if (key.startsWith(`${targetId}:`)) this.outboxes.delete(key);
    }
    for (const key of this.pendingDeltas.keys()) {
      if (key.startsWith(`${targetId}:`)) this.pendingDeltas.delete(key);
    }
  }

  targetOf(id: string): ClientTarget | null {
    return this.targets.get(id) ?? null;
  }

  mintHostId(): string {
    this.hostIdCounter += 1;
    return `g${this.hostIdCounter}`;
  }

  fanoutEvent(spec: { threadId: string; name: string; payload: unknown; agentName?: string }): void {
    const { threadId } = spec;
    const seq = (this.perThreadSeq.get(threadId) ?? 0) + 1;
    this.perThreadSeq.set(threadId, seq);
    const body: EventBody = { threadId, name: spec.name, payload: spec.payload, ...(spec.agentName !== undefined ? { agentName: spec.agentName } : {}) };
    for (const target of this.targets.values()) {
      if (threadId !== "*" && target.tier !== "owner" && !target.subscribedThreads.has(threadId)) {
        if (typeof process !== "undefined" && process.env["GW_DEBUG"]) process.stderr.write(`fanout skip ${target.target} sub=[${[...target.subscribedThreads].join(",")}] t=${threadId}\n`);
        continue;
      }
      const streamId = `ev:${threadId}`;
      const outbox = this.outboxFor(target.target, streamId);
      const { frame } = outbox.enqueue(body, "event", null);
      this.deliverCoalesced(target, streamId, frame);
    }
  }

  fanoutUiRequest(body: { requestId: string; threadId: string; method: string; payload: Record<string, unknown> }): void {
    for (const target of this.targets.values()) {
      if (this.effectiveTier(target.target) === "read") continue;
      const streamId = "ui";
      const outbox = this.outboxFor(target.target, streamId);
      const { frame } = outbox.enqueue(body, "ui_request", null);
      target.send(frame);
    }
  }

  deliverResponse(hostId: string, frame: Frame): boolean {
    void hostId;
    void frame;
    return false;
  }

  private outboxFor(targetId: string, streamId: string): OutboxStream {
    const key = `${targetId}:${streamId}`;
    let outbox = this.outboxes.get(key);
    if (outbox === undefined) {
      outbox = new OutboxStream(streamId);
      this.outboxes.set(key, outbox);
    }
    if (outbox.replayWindowExceeded()) {
      outbox.compactOldest(REPLAY_BUFFER_MAX);
    }
    return outbox;
  }

  applyAckFor(targetId: string, streamId: string, upTo: number): void {
    this.outboxFor(targetId, streamId).applyAck(upTo);
  }

  private deliverCoalesced(target: ClientTarget, streamId: string, frame: Frame): void {
    const event = frame.body as EventBody;
    if (!COALESCABLE.has(event.name)) {
      target.send(frame);
      return;
    }
    const now = this.options.now();
    this.pendingDeltas.set(
      `${target.target}:${streamId}`,
      { frame, at: now },
    );
    this.flushDeltas(target.target);
  }

  private readonly pendingDeltas = new Map<string, { frame: Frame; at: number }>();

  flushDeltas(targetId: string): void {
    const target = this.targets.get(targetId);
    if (target === undefined) return;
    for (const [key, entry] of this.pendingDeltas) {
      if (!key.startsWith(`${targetId}:`)) continue;
      target.send(entry.frame);
      this.pendingDeltas.delete(key);
    }
  }
}
