export const HUB_ERROR_CODES = [
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

export type HubErrorCode = (typeof HUB_ERROR_CODES)[number];

export interface HubErrorShape {
  code: HubErrorCode;
  message: string;
}

export function hubError(code: HubErrorCode, message: string): HubErrorShape {
  return { code, message };
}

export function isHubErrorShape(value: unknown): value is HubErrorShape {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["code"] === "string" && HUB_ERROR_CODES.includes(record["code"] as HubErrorCode) && typeof record["message"] === "string";
}

export class CodedError extends Error {
  readonly code: HubErrorCode;

  constructor(code: HubErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function errorOfCause(cause: unknown, fallback: HubErrorCode = "internal"): HubErrorShape {
  if (cause instanceof CodedError) return { code: cause.code, message: cause.message };
  return { code: fallback, message: cause instanceof Error ? cause.message : String(cause) };
}
