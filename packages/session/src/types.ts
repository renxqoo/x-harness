// Session 契约类型：事件信封判别联合、16 词条闭合词表、surface 投影、仓库接口（docs/SESSION.md §1）

import type { Result } from "@x-harness/core";

export type SessionId = string & { readonly __brand: "SessionId" };

/** 无格式版本字段：格式身份判别 = 闭合词表 + fail-closed 校验（docs/SESSION.md §1.6）；
 *  语义级变更（改既有词条含义/信封机制）发生的当下再引入显式判别字段，字段缺失即变更前档案 */
export interface SessionHeader {
  readonly id: SessionId;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: SessionId;
  /** 子代理元数据（delegation spawn 落盘）：agentId 是唯一身份且跨重启稳定——
   *  复活按 agentId 寻址、复活后 id 不变（件13 修订A「去名」裁决） */
  readonly agentId?: string;
  readonly agentType?: string;
  readonly agentDepth?: number;
  /** worktree 隔离子的工作树路径（复活重放 rootOverride 的锚——件13 §6.2） */
  readonly agentWorktree?: string;
}

export type TurnEndReason =
  | { readonly kind: "completed" }
  | { readonly kind: "aborted"; readonly cause?: string }
  | { readonly kind: "blocked" }
  | { readonly kind: "error"; readonly message: string; readonly code?: string }
  | { readonly kind: "max-tokens" }
  | { readonly kind: "interrupted" };

export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly callId: string; readonly name: string; readonly input: string };

export interface ToolRef {
  readonly name: string;
  readonly description?: string;
}

export interface SessionEventData {
  readonly "turn/start": { readonly turn: number };
  readonly "turn/end": { readonly turn: number; readonly reason: TurnEndReason };
  readonly "step/start": { readonly turn: number; readonly step: number };
  readonly "step/end": { readonly turn: number; readonly step: number };
  readonly "system/message": { readonly turn: number; readonly step: number; readonly text: string };
  readonly "user/message": { readonly turn: number; readonly step: number; readonly content: readonly ContentBlock[] };
  readonly "assistant/message": {
    readonly turn: number;
    readonly step: number;
    readonly content: readonly ContentBlock[];
    readonly usage?: unknown;
    readonly stopReason?: string;
    readonly interrupted?: true;
  };
  /** 失败尝试：中断前已收到的 usage 帧随尝试落账（token-meter 失败尝试计费） */
  readonly "assistant/attempt": { readonly turn: number; readonly step: number; readonly error: string; readonly usage?: unknown };
  readonly "tool/call": { readonly turn: number; readonly step: number; readonly callId: string; readonly name: string; readonly arguments: string };
  readonly "tool/result": { readonly turn: number; readonly step: number; readonly callId: string; readonly content: string; readonly isError?: true };
  readonly "request/header": {
    readonly model: string;
    readonly provider?: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
    /** 思考等级（agent-loop Dial 折叠面，docs/LLM-PI.md）：词表 "off"|"low"|"medium"|"high" */
    readonly thinking?: string;
    readonly tools: readonly ToolRef[];
  };
  readonly "request/context": { readonly provider: string; readonly model: string; readonly contextWindow?: number };
  /** 重试调度审计（docs/LLM-RETRY.md §1）：先于等待落账；预算为进程内计数，事件是观测面 */
  readonly "llm/retry": {
    readonly turn: number;
    readonly step: number;
    readonly provider: string;
    readonly retry: number;
    readonly delayMs: number;
    readonly failure: { readonly message: string; readonly code?: string };
  };
  readonly "session/end-seed": { readonly inherited?: true };
  /** 收件箱拼接：fold 投影归 agent-loop（docs/SESSION-RESUME.md §1.1——claim 按成员移除、判重按当前在场） */
  readonly "agent/inbox/spliced": InboxSpliceData;
  /** autocompact 账本快照（docs/COMPACTION.md §1.2/§2.B）：log-only 持久化面——重开恢复
   *  折叠 last-wins；ledger 为序列化原文，coveredSeq = 已收编覆盖的 journal seq 边界 */
  readonly "autocompact/checkpoint": {
    readonly turn: number;
    readonly step: number;
    readonly ledger: string;
    readonly coveredSeq: number;
    readonly stale?: true;
  };
}

export type InboxTarget = "next-turn" | "next-step";

export interface InboxEntry {
  readonly id: string;
  readonly content: readonly ContentBlock[];
}

export type InboxSpliceData =
  | { readonly op: "insert"; readonly target: InboxTarget; readonly entries: readonly InboxEntry[] }
  | { readonly op: "claim"; readonly target: InboxTarget; readonly turn: number; readonly claimed: readonly string[] }
  | { readonly op: "clear"; readonly reason: string };

export type SessionEventType = keyof SessionEventData;
/** 产模型可见消息的词条：仅此 4 类可携带 surfaceOp */
export type SurfaceEventType = "system/message" | "user/message" | "assistant/message" | "tool/result";
export type LogOnlyEventType = Exclude<SessionEventType, SurfaceEventType>;

export type SurfaceOp = "append" | { readonly op: "replace"; readonly startSeq: number; readonly endSeq: number };

export interface SurfaceIntent {
  readonly surfaceOp: SurfaceOp;
}

export type SessionEvent<K extends SessionEventType = SessionEventType> = {
  [L in K]: {
    readonly type: L;
    readonly seq: number;
    readonly time: number;
    readonly data: SessionEventData[L];
  } & (L extends SurfaceEventType ? { readonly surfaceOp: SurfaceOp } : { readonly surfaceOp?: never });
}[K];

export interface SurfaceNode<K extends SurfaceEventType = SurfaceEventType> {
  readonly seq: number;
  readonly event: SessionEvent<K>;
}

export type SurfaceMessage =
  | { readonly role: "system"; readonly text: string }
  | { readonly role: "user"; readonly content: readonly ContentBlock[] }
  | { readonly role: "assistant"; readonly content: readonly ContentBlock[]; readonly usage?: unknown; readonly stopReason?: string }
  | { readonly role: "tool"; readonly callId: string; readonly content: string; readonly isError?: true };

export interface Session {
  readonly id: SessionId;
  readonly header: SessionHeader;
  append<K extends SurfaceEventType>(type: K, data: SessionEventData[K], intent: SurfaceIntent): Result<SessionEvent<K>>;
  append<K extends LogOnlyEventType>(type: K, data: SessionEventData[K]): Result<SessionEvent<K>>;
  events(): readonly SessionEvent[];
  surface(): readonly SurfaceNode[];
  deriveMessages(): readonly SurfaceMessage[];
}

export interface CreateSessionOptions {
  readonly id?: SessionId;
  /** resume/replay 的历史前缀：校验通过后由构造器追加 end-seed（不带 inherited） */
  readonly seed?: readonly SessionEvent[];
  /** 血缘回填：resume 消费方从 archive.read 的 header.parentSession 取（fork 内部自动携带） */
  readonly parent?: SessionId;
  /** 子代理元数据透传（birth 落 header；resume 的归档 header 分支忽略——归档原文为准） */
  readonly agent?: { readonly id: string; readonly type: string; readonly depth: number; readonly worktree?: string };
  /** resume 的归档 header 原文：提供时以它为准（id 取 header.id、parent 忽略、归档元数据保留） */
  readonly header?: SessionHeader;
}

export interface ForkSessionOptions {
  /** 前缀切口（闭区间右端）；值域 0 ≤ untilSeq < 源日志长度，空前缀非法 */
  readonly untilSeq?: number;
  readonly id?: SessionId;
}

export interface SessionStore {
  create(options?: CreateSessionOptions): Promise<Result<Session>>;
  fork(source: SessionId, options?: ForkSessionOptions): Promise<Result<Session>>;
  get(id: SessionId): Session | undefined;
  list(): readonly SessionId[];
  /** 落盘屏障：空屏障语义——未装配持久化插件时成功不承诺字节落盘（docs/SESSION.md §1.5） */
  flush(id: SessionId): Promise<Result<true>>;
  dispose(id: SessionId): Result<true>;
}

export interface SessionSnapshot {
  readonly header: SessionHeader;
  readonly events: readonly SessionEvent[];
}

export interface SessionArchive {
  list(): readonly SessionId[];
  read(id: SessionId): Promise<Result<SessionSnapshot>>;
  /** 轻量 header 投影（不读事件卷）——delegation 按名惰性复活的扫描面；坏档案跳过不列 */
  listHeaders(): Promise<readonly SessionHeader[]>;
}
