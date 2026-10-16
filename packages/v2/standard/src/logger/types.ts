import type { JsonValue, MaybePromise } from "../../../core/src/index";

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogInput { readonly message: string; readonly fields?: JsonValue }
export interface LogRecord extends LogInput { readonly level: LogLevel; readonly time: number }
export interface LoggerOptions {
  readonly write: (this: void, record: LogRecord, signal: AbortSignal) => MaybePromise<void>;
  readonly level?: LogLevel;
  readonly now?: (this: void) => number;
}
