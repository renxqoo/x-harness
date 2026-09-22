// Session 契约类型：事件信封判别联合、18 词条闭合词表、surface 投影、仓库接口（docs/SESSION.md §1）

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
  /** spawn 任务摘要（delegation 入参 description 原文）——面板 work 展示与复活回填的持久锚 */
  readonly agentWork?: string;
  /** worktree 隔离子的工作树路径（复活重放 rootOverride 的锚——件13 §6.2） */
  readonly agentWorktree?: string;
}

export type TurnEndReason =
  | { readonly kind: "completed" }
  | { readonly kind: "aborted"; readonly cause?: string }
  | { readonly kind: "blocked"; readonly reason?: string }
  | { readonly kind: "error"; readonly message: string; readonly code?: string }
  | { readonly kind: "max-tokens" }
  | { readonly kind: "interrupted" };

export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly callId: string; readonly name: string; readonly input: string }
  | { readonly type: "image"; readonly data: string; readonly mediaType: string };

/** user 域图像块（prompt 携图）：data = 纯 base64 载荷（无 data: 前缀），mediaType = MIME。
 *  仅 user 域合法——assistant 域由 gates 拒（驱动永不铸 assistant image） */
export type ImageBlock = Extract<ContentBlock, { readonly type: "image" }>;

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
    /** 本 attempt 思考全文（落盘不回传——docs/STREAM-PARTIAL-PERSISTENCE.md；缺席=无思考） */
    readonly thinking?: string;
    readonly usage?: unknown;
    readonly stopReason?: string;
    readonly interrupted?: true;
  };
  /** 失败尝试：中断前已收增量随尝试落账（content/thinking——STREAM-PARTIAL-PERSISTENCE；
   *  usage 帧 token-meter 失败尝试计费） */
  readonly "assistant/attempt": {
    readonly turn: number;
    readonly step: number;
    readonly error: string;
    readonly content?: readonly ContentBlock[];
    readonly thinking?: string;
    readonly usage?: unknown;
  };
  readonly "tool/call": { readonly turn: number; readonly step: number; readonly callId: string; readonly name: string; readonly arguments: string };
  readonly "tool/result": { readonly turn: number; readonly step: number; readonly callId: string; readonly content: string; readonly isError?: true };
  readonly "request/header": {
    readonly model: string;
    readonly provider?: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
    /** 思考等级（agent-loop Dial 折叠面，docs/LLM-PI.md）：词表 "off"|"low"|"medium"|"high"|"max" */
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
  /** todo 清单全量快照（docs/TODO.md §13——log-only；每次变更后 last-wins 落账，恢复侧惰性 fold） */
  readonly "todo/snapshot": TodoSnapshotEventData;
  /** 会话级 KV（log-only；last-wins 折叠归消费方——内核只运不判）：宿主侧标题/拨号/
   *  思考档/权限档等持久事实的单一事实通道（WAL 随 fork/恢复天然携带） */
  readonly "session/meta": { readonly key: string; readonly value: unknown };
  /** 命令生命周期（BATCH3-DESIGN §2.2，log-only）：commandId 配对镜像 tool/call↔tool/result；
   *  run 的 args 缺席 = 命令定义 recordInput:false；悬挂 run（无 done）合法——torn 卷可恢复 */
  readonly "command/run": { readonly commandId: string; readonly name: string; readonly args?: string };
  readonly "command/done": { readonly commandId: string; readonly kind: "success" | "error"; readonly text?: string };
}

/** todo 快照内单任务（docs/TODO.md §13.2）：id 十进制规范形、status 三值闭合（无 deleted——物理移除不进快照） */
export interface TodoSnapshotTaskData {
  readonly id: string;
  readonly subject: string;
  readonly status: "pending" | "in_progress" | "completed";
  readonly description?: string;
  readonly activeForm?: string;
  readonly owner?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** todo 快照事件 data（docs/TODO.md §13.2）：桶闭包状态三件——计数器 + 行集 + 单源边集展平 */
export interface TodoSnapshotEventData {
  readonly seq: number;
  readonly tasks: readonly TodoSnapshotTaskData[];
  /** [blocker, blocked] 依赖边（blocksOf 展平；自环与悬空引用由词条门拒） */
  readonly edges: readonly (readonly [blocker: string, blocked: string])[];
}

export type InboxTarget = "next-turn" | "next-step";

export interface InboxEntry {
  readonly id: string;
  readonly content: readonly ContentBlock[];
}

export type InboxSpliceData =
  | { readonly op: "insert"; readonly target: InboxTarget; readonly entries: readonly InboxEntry[] }
  | { readonly op: "claim"; readonly target: InboxTarget; readonly turn: number; readonly claimed: readonly string[] }
  | { readonly op: "clear"; readonly reason: string }
  /** 单条移除（queue/drop 命令直写；被删消息不进上下文，与 claim 严格区分） */
  | { readonly op: "drop"; readonly target: InboxTarget; readonly dropped: readonly string[]; readonly reason: string }
  /** 单条改道（queue/send_now：next-turn 队首改为当前轮步边界注入；entry 本体与 id 原样保留） */
  | { readonly op: "retarget"; readonly id: string; readonly to: InboxTarget };

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
  readonly agent?: { readonly id: string; readonly type: string; readonly depth: number; readonly work?: string; readonly worktree?: string };
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
