// 事件扇出与认领式响应路由（DESIGN §1.2.1/§1.2.3）：单写者、全序、id 重映射、
// 订阅域过滤、WAL seq 域双端一致、coalesce（delta 类帧背压合并）。
import type { EventBody, Frame } from "@x-harness/remote-protocol";
import { OutboxStream, REPLAY_BUFFER_MAX } from "@x-harness/remote-protocol";

/** host 输出帧前缀分类（不 parse body） */
export type HostFrameKind = "response" | "event" | "ui_request" | "heartbeat" | "hub_error" | "thread_died" | "thread_parked" | "unknown";

/** host 帧 key 序契约：response 为 id-first（host frame-classify 单点同源）；其余 type-first */
export function classifyHostLine(line: string): HostFrameKind {
  if (line.startsWith('{"id":')) return "response"; // host responseLine 恒 id-first（含 null/undefined id）
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
  /** 设备 id（远程）或 "owner" */
  target: string;
  tier: "read" | "interact" | "full" | "owner";
  subscribedThreads: Set<string>;
  send(frame: Frame): void;
}

/** tier 裁决器（scope 变更即时生效——D4：fanout 不再持过期 tier 拷贝） */
export type TierResolver = (target: string) => "read" | "interact" | "full" | "owner";

export interface FanoutOptions {
  coalesceBacklogFrames: number;
  coalesceLagMs: number;
  now(): number;
}

/** 可合并的 delta 事件名（DESIGN §4 流量整形） */
const COALESCABLE = new Set(["agent/assistant-stream", "llm/chunk", "agent/tool-stream", "bash_execution_update"]);

export class Fanout {
  private readonly targets = new Map<string, ClientTarget>();
  private tierResolver: TierResolver | null = null;
  private readonly outboxes = new Map<string, OutboxStream>(); // target → per-thread outbox 复用单流
  private readonly perThreadSeq = new Map<string, number>();
  private hostIdCounter = 0;

  constructor(private readonly options: FanoutOptions) {}

  attach(target: ClientTarget): void {
    this.targets.set(target.target, target);
  }

  /** tier 裁决器注入（scope 变更即时生效） */
  setTierResolver(resolver: TierResolver | null): void {
    this.tierResolver = resolver;
  }

  /** 当前有效 tier（resolver 优先；缺席用 attach 时快照） */
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

  /** host 命令 id 自铸（§1.2.1 id 重映射；永不撞 @hub-internal: 保留前缀） */
  mintHostId(): string {
    this.hostIdCounter += 1;
    return `g${this.hostIdCounter}`;
  }

  /** 事件扇出：订阅域 + scope 过滤（read 设备不见 ui_request）+ WAL seq 域 + coalesce */
  fanoutEvent(spec: { threadId: string; name: string; payload: unknown; agentName?: string }): void {
    const { threadId } = spec;
    const seq = (this.perThreadSeq.get(threadId) ?? 0) + 1;
    this.perThreadSeq.set(threadId, seq);
    const body: EventBody = { threadId, name: spec.name, payload: spec.payload, ...(spec.agentName !== undefined ? { agentName: spec.agentName } : {}) };
    for (const target of this.targets.values()) {
      // owner 恒收全部线程事件（全权观察者）；设备按订阅域
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

  /** ui_request 广播（scope 过滤——interact 及以上，§1.2.1 M12 处置） */
  fanoutUiRequest(body: { requestId: string; threadId: string; method: string; payload: Record<string, unknown> }): void {
    for (const target of this.targets.values()) {
      if (this.effectiveTier(target.target) === "read") continue;
      const streamId = "ui";
      const outbox = this.outboxFor(target.target, streamId);
      const { frame } = outbox.enqueue(body, "ui_request", null);
      target.send(frame);
    }
  }

  /** response 认领回投（id 重映射后按发起者回投；无人认领丢弃+计数） */
  deliverResponse(hostId: string, frame: Frame): boolean {
    void hostId;
    void frame;
    return false; // 由 gateway 命令管线实现（需访问 pending 映射）
  }

  private outboxFor(targetId: string, streamId: string): OutboxStream {
    const key = `${targetId}:${streamId}`;
    let outbox = this.outboxes.get(key);
    if (outbox === undefined) {
      outbox = new OutboxStream(streamId);
      this.outboxes.set(key, outbox);
    }
    // C3：outbox 硬上限（owner/无 ACK 客户端不再无界增长——丢最旧保连接）
    if (outbox.replayWindowExceeded()) {
      outbox.compactOldest(REPLAY_BUFFER_MAX);
    }
    return outbox;
  }

  /** ACK 水位推进（设备侧 ack 帧 → 对应 outbox 释放） */
  applyAckFor(targetId: string, streamId: string, upTo: number): void {
    this.outboxFor(targetId, streamId).applyAck(upTo);
  }

  /** coalesce：目标 ACK 积压（简化为投递节流）超阈值时 delta 帧合并 */
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
