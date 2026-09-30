export const SDK_ERROR_CODES = [
  "unknown_thread",
  "thread_superseded",
  "thread_not_live",
  "session_unreadable",
  "already_open",
  "thread_limit",
  "streaming_window",
  "invalid_input",
  "unknown_command",
  "capability_thinking",
  "capability_images",
  "capability_plugin",
  "images_too_many",
  "model_unavailable",
  "cursor_stale",
  "state_conflict",
  "name_conflict",
  "trust_required",
  "path_forbidden",
  "io_failed",
  "internal",
  "bash_denied",
  "protocol",
  "compact_rejected",
  "plugin_install_failed",
  "plugin_uninstall_failed",
] as const;

export type SdkErrorCode = (typeof SDK_ERROR_CODES)[number];

export interface SdkErrorShape {
  code: SdkErrorCode;
  message: string;
}

export function sdkError(code: SdkErrorCode, message: string): SdkErrorShape {
  return { code, message };
}

export function isSdkErrorShape(value: unknown): value is SdkErrorShape {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["code"] === "string" && SDK_ERROR_CODES.includes(record["code"] as SdkErrorCode) && typeof record["message"] === "string";
}

export class CodedError extends Error {
  readonly code: SdkErrorCode;

  constructor(code: SdkErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function errorOfCause(cause: unknown, fallback: SdkErrorCode = "internal"): SdkErrorShape {
  if (cause instanceof CodedError) return { code: cause.code, message: cause.message };
  return { code: fallback, message: cause instanceof Error ? cause.message : String(cause) };
}

export type SdkResult<T> = { ok: true; value: T } | { ok: false; reason: SdkErrorShape };
