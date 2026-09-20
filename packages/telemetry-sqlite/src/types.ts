// telemetry-sqlite 契约类型：宿主执行面、事务边界、行类型、词表闭合常量。
// 词表是外部契约（docs/TELEMETRY-SQLITE.md §1.2/§1.3）——常量数组供测试双向封闭断言，
// 词表扩充 = 文档节 + 常量 + 测试三处同步（缺一即契约漂移）。

/** sqlite 参数值域（bun:sqlite 绑定面） */
export type SqlValue = null | number | string | bigint | Uint8Array;

/** 宿主提供的 sqlite 执行面——连接归宿主，插件只拿执行器（e2e SqliteDb 契约同款形态） */
export interface SqliteExecutor {
  /** 预编译执行：INSERT/UPDATE/CREATE 等，返回变更行数 */
  run(sql: string, params?: readonly SqlValue[]): { changes: number | bigint };
  /** 预编译查询：SELECT 返回全部行 */
  all<T extends Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): T[];
}

/** 事务边界（可选提供；缺省时批次退化为逐条 run——测试替身用） */
export interface SqliteTx {
  begin(): void;
  commit(): void;
  rollback(): void;
}

export interface TelemetryResource {
  readonly serviceName: string;
  readonly version?: string;
  /** OTel resource attributes（deployment.environment 等），JSON 序列化入库 */
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface SessionUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface TelemetryQueryService {
  /** 会话的 span 行（start_ms 序） */
  spansOf(sessionId: string): SpanRow[];
  /** 会话的 log 流（seq 序） */
  logsOf(sessionId: string): LogRow[];
  /** 会话 token 用量（llm span 的 gen_ai.usage 聚合；无 llm span 时 undefined） */
  usageOf(sessionId: string): SessionUsageTotals | undefined;
  /** 手动留存治理（级联删三表该会话行）；返回删除总行数 */
  deleteSession(sessionId: string): number;
}

export interface SpanRow {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly sessionId: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly startMs: number;
  readonly endMs: number | null;
  readonly statusCode: SpanStatus;
  readonly statusMessage: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface LogRow {
  readonly sessionId: string;
  readonly seq: number;
  readonly tsMs: number;
  readonly traceId: string;
  readonly spanId: string | null;
  readonly severity: LogSeverity;
  readonly eventType: string;
  readonly body: string | null;
}

// —— 词表（闭合契约，测试双向锁死） ——

export const SPAN_KINDS = ["INTERNAL", "CLIENT"] as const;
export type SpanKind = (typeof SPAN_KINDS)[number];

export const SPAN_STATUSES = ["OK", "ERROR", "UNSET"] as const;
export type SpanStatus = (typeof SPAN_STATUSES)[number];

export const LOG_SEVERITIES = ["INFO", "WARN", "ERROR"] as const;
export type LogSeverity = (typeof LOG_SEVERITIES)[number];

/** span 名首段闭合词表（tool.<name> / llm.chat 动态段不在此列） */
export const SPAN_NAMES = ["session", "turn", "step", "llm.chat"] as const;

/** schema 版本：非空且 != 当前值 → 装载失败（fail-closed，未来迁移时递增） */
export const SCHEMA_VERSION = 1;

export interface SqliteTelemetryOptions {
  readonly db: SqliteExecutor;
  readonly tx?: SqliteTx;
  readonly resource: TelemetryResource;
  /** OTel logs body 全量保真开关（缺省 true） */
  readonly includeBodies?: boolean;
  /** fire-and-forget 路径（created 首灌/disposed 终排空/实时段失败）的 I/O 失败上报；缺省 stderr */
  readonly onIoError?: (message: string) => void;
}
