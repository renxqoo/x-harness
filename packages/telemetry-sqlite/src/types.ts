export type SqlValue = null | number | string | bigint | Uint8Array;

export interface SqliteExecutor {
  run(sql: string, params?: readonly SqlValue[]): { changes: number | bigint };
  all<T extends Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): T[];
}

export interface SqliteTx {
  begin(): void;
  commit(): void;
  rollback(): void;
}

export interface TelemetryResource {
  readonly serviceName: string;
  readonly version?: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface SessionUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface TelemetryQueryService {
  spansOf(sessionId: string): SpanRow[];
  logsOf(sessionId: string): LogRow[];
  usageOf(sessionId: string): SessionUsageTotals | undefined;
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


export const SPAN_KINDS = ["INTERNAL", "CLIENT"] as const;
export type SpanKind = (typeof SPAN_KINDS)[number];

export const SPAN_STATUSES = ["OK", "ERROR", "UNSET"] as const;
export type SpanStatus = (typeof SPAN_STATUSES)[number];

export const LOG_SEVERITIES = ["INFO", "WARN", "ERROR"] as const;
export type LogSeverity = (typeof LOG_SEVERITIES)[number];

export const SPAN_NAMES = ["session", "turn", "step", "llm.chat"] as const;

export const SCHEMA_VERSION = 1;

export interface SqliteTelemetryOptions {
  readonly db: SqliteExecutor;
  readonly tx?: SqliteTx;
  readonly resource: TelemetryResource;
  readonly includeBodies?: boolean;
  readonly onIoError?: (message: string) => void;
}
